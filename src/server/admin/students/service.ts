import { addMembers } from "../groups/service";
import { assertLevelPickable } from "../groups/pickers";
import { isFull } from "../groups/rules";
import { pageWindow } from "../list";
import type { CreateStudentInput, UpdateStudentInput } from "../people/schema";
import { createPerson, updatePersonIdentity } from "../people/service";
import { AdminError, type Message, msg } from "../result";
import {
  activeSlotWhere,
  assertFresh,
  audit,
  notFound,
  type SchoolDb,
  type Scope,
} from "../shared";
import {
  CURRENT_MEMBERSHIP,
  type StudentFilters,
  studentWhere,
} from "./filters";

export async function listStudents(db: SchoolDb, filters: StudentFilters) {
  const where = studentWhere(filters);
  const total = await db.studentProfile.count({ where });
  const window = pageWindow(filters.page, total);
  const students = await db.studentProfile.findMany({
    where,
    orderBy: { user: { name: "asc" } },
    skip: window.skip,
    take: window.take,
    select: {
      id: true,
      phone: true,
      levelId: true,
      level: { select: { code: true, archivedAt: true } },
      user: {
        select: { id: true, name: true, email: true, deletedAt: true },
      },
      groupMemberships: {
        where: CURRENT_MEMBERSHIP,
        orderBy: { group: { name: "asc" } },
        select: { group: { select: { id: true, name: true } } },
      },
    },
  });
  const [activeCount, anyCount] = await Promise.all([
    db.studentProfile.count({ where: { user: { deletedAt: null } } }),
    db.studentProfile.count(),
  ]);
  return {
    students: students.map((student) => ({
      id: student.id,
      userId: student.user.id,
      name: student.user.name,
      email: student.user.email,
      archived: !!student.user.deletedAt,
      phone: student.phone,
      levelId: student.levelId,
      level: student.level,
      groups: student.groupMemberships.map((m) => m.group),
    })),
    total,
    window,
    activeCount,
    anyCount,
  };
}

/** Options for the list filters: every level and every group. */
export async function studentFilterOptions(db: SchoolDb) {
  const [levels, groups] = await Promise.all([
    db.level.findMany({
      orderBy: { rank: "asc" },
      select: { id: true, code: true, name: true, archivedAt: true },
    }),
    db.group.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, deletedAt: true },
    }),
  ]);
  return { levels, groups };
}

export async function getStudent(db: SchoolDb, id: string, today: Date) {
  const student = await db.studentProfile.findUnique({
    where: { id },
    select: {
      id: true,
      phone: true,
      levelId: true,
      updatedAt: true,
      level: { select: { code: true, name: true, archivedAt: true } },
      user: {
        select: { id: true, name: true, email: true, deletedAt: true },
      },
      groupMemberships: {
        orderBy: { joinedAt: "desc" },
        select: {
          id: true,
          joinedAt: true,
          leftAt: true,
          group: {
            select: {
              id: true,
              name: true,
              type: true,
              levelId: true,
              deletedAt: true,
              level: { select: { code: true } },
              timetableSlots: {
                where: activeSlotWhere(today),
                select: {
                  teacher: { select: { user: { select: { name: true } } } },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!student) return null;
  const memberships = student.groupMemberships.map(({ group, ...m }) => ({
    ...m,
    groupId: group.id,
    name: group.name,
    type: group.type,
    levelId: group.levelId,
    levelCode: group.level.code,
    archived: !!group.deletedAt,
    teachers: [
      ...new Set(group.timetableSlots.map((slot) => slot.teacher.user.name)),
    ].sort(),
  }));
  return {
    id: student.id,
    userId: student.user.id,
    name: student.user.name,
    email: student.user.email,
    archived: !!student.user.deletedAt,
    phone: student.phone,
    levelId: student.levelId,
    level: student.level,
    updatedAt: student.updatedAt,
    current: memberships.filter((m) => m.leftAt === null),
    past: memberships
      .filter((m) => m.leftAt !== null)
      .sort((a, b) => b.leftAt!.getTime() - a.leftAt!.getTime()),
  };
}

/** The group a new student joins must be active and have a free place. */
async function assertGroupHasPlace(db: SchoolDb, groupId: string) {
  const group = await db.group.findUnique({
    where: { id: groupId },
    select: {
      capacity: true,
      deletedAt: true,
      _count: { select: { memberships: { where: { leftAt: null } } } },
    },
  });
  if (!group || group.deletedAt) {
    throw new AdminError(msg("groups.error.archivedChoice"), "groupId");
  }
  if (isFull(group.capacity, group._count.memberships)) {
    throw new AdminError(msg("groups.members.full"), "groupId");
  }
}

/**
 * Creates the student (user, membership, profile) and optionally enrols
 * them in a group from `today`. The group's free place is checked first
 * and again under the group lock; if it filled up in between, the student
 * is still created and a warning is returned.
 */
export async function createStudent(
  scope: Scope,
  input: CreateStudentInput,
  today: Date,
) {
  const { db, schoolId } = scope;
  if (input.levelId) await assertLevelPickable(db, input.levelId, "levelId");
  if (input.groupId) await assertGroupHasPlace(db, input.groupId);
  let studentId = "";
  const userId = await createPerson(
    scope,
    "STUDENT",
    { name: input.name, email: input.email, password: input.password },
    async (tx, userId) => {
      const profile = await tx.studentProfile.create({
        data: {
          schoolId,
          userId,
          levelId: input.levelId,
          phone: input.phone,
        },
        select: { id: true },
      });
      studentId = profile.id;
    },
  );
  const warnings: Message[] = [];
  if (input.groupId) {
    try {
      await addMembers(scope, input.groupId, [studentId], today);
    } catch (error) {
      if (!(error instanceof AdminError)) throw error;
      warnings.push(msg("students.warning.notAddedToGroup"));
    }
  }
  return { id: studentId, userId, warnings };
}

async function findStudent(db: SchoolDb, id: string) {
  const student = await db.studentProfile.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      levelId: true,
      updatedAt: true,
      user: { select: { name: true } },
    },
  });
  if (!student) throw notFound();
  return student;
}

/** Profile tab: identity (User) and profile fields (§6.6). */
export async function updateStudent(
  scope: Scope,
  id: string,
  input: UpdateStudentInput,
) {
  const { db } = scope;
  const student = await findStudent(db, id);
  assertFresh(student, input.updatedAt);
  if (input.levelId) {
    await assertLevelPickable(db, input.levelId, "levelId", student.levelId);
  }
  await updatePersonIdentity(scope, student.userId, {
    name: input.name,
    email: input.email,
  });
  await db.studentProfile.update({
    where: { id },
    data: { levelId: input.levelId, phone: input.phone },
  });
  await audit(scope, "student.updated", "StudentProfile", id);
  return { id, name: input.name };
}
