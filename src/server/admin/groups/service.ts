import type { GroupType } from "@/generated/prisma/enums";
import { formatMinutes } from "@/server/scheduling";

import { type ListParams, pageWindow, searchWhere, statusWhere } from "../list";
import { AdminError, blockedError, msg } from "../result";
import {
  activeSlotWhere,
  assertFresh,
  audit,
  isUniqueViolation,
  notFound,
  type SchoolDb,
  type Scope,
  uniqueError,
} from "../shared";
import { CURRENT_MEMBERSHIP } from "../students/filters";
import { assertLevelPickable } from "./pickers";
import {
  canChangeType,
  capacityError,
  levelMismatch,
  planAddMembers,
  removalError,
  timeClash,
} from "./rules";
import {
  type LessonTimesInput,
  type RoomInfo,
  roomClashes,
} from "./lesson-times";
import type { GroupInput } from "./schema";

type Tx = Parameters<Parameters<SchoolDb["$transaction"]>[0]>[0];

/**
 * Membership changes and capacity edits of one group are serialised with a
 * transaction-scoped advisory lock, so two admins can never overfill it.
 */
async function lockGroup(tx: Tx, groupId: string) {
  const key = `group-members:${groupId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

const ACTIVE_MEMBERS = { where: { leftAt: null } } as const;

// ---------------------------------------------------------------------------
// Lists and options
// ---------------------------------------------------------------------------

export type GroupFilters = ListParams & {
  type: GroupType | null;
  level: string | null;
  course: string | null;
};

const distinct = (names: string[]) => [...new Set(names)].sort();

export async function listGroups(
  db: SchoolDb,
  filters: GroupFilters,
  today: Date,
) {
  const where = {
    ...statusWhere(filters.status, "deletedAt"),
    ...searchWhere(filters.q, ["name"]),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.level ? { levelId: filters.level } : {}),
    ...(filters.course ? { courseId: filters.course } : {}),
  };
  const total = await db.group.count({ where });
  const window = pageWindow(filters.page, total);
  const groups = await db.group.findMany({
    where,
    orderBy: { name: "asc" },
    skip: window.skip,
    take: window.take,
    select: {
      id: true,
      name: true,
      type: true,
      capacity: true,
      levelId: true,
      courseId: true,
      deletedAt: true,
      updatedAt: true,
      level: { select: { code: true, archivedAt: true } },
      course: { select: { name: true } },
      lessonTimes: {
        select: { weekday: true, startMinute: true, endMinute: true },
      },
      timetableSlots: {
        where: activeSlotWhere(today),
        select: { teacher: { select: { user: { select: { name: true } } } } },
      },
      _count: { select: { memberships: ACTIVE_MEMBERS, lessons: true } },
    },
  });
  const [activeCount, anyCount] = await Promise.all([
    db.group.count({ where: { deletedAt: null } }),
    db.group.count(),
  ]);
  return {
    groups: groups.map(({ _count, timetableSlots, ...group }) => ({
      ...group,
      members: _count.memberships,
      lessons: _count.lessons,
      teachers: distinct(timetableSlots.map((slot) => slot.teacher.user.name)),
    })),
    total,
    window,
    activeCount,
    anyCount,
  };
}

/** Levels, courses and active students for the group form. */
export async function groupFormOptions(db: SchoolDb) {
  const [levels, courses, students] = await Promise.all([
    db.level.findMany({
      orderBy: { rank: "asc" },
      select: { id: true, code: true, name: true, archivedAt: true },
    }),
    db.course.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, levelId: true },
    }),
    activeStudentOptions(db),
  ]);
  return { levels, courses, students };
}

async function activeStudentOptions(db: SchoolDb) {
  const students = await db.studentProfile.findMany({
    where: { user: { deletedAt: null } },
    orderBy: { user: { name: "asc" } },
    select: {
      id: true,
      levelId: true,
      level: { select: { code: true } },
      user: { select: { name: true, email: true } },
    },
  });
  return students.map((student) => ({
    id: student.id,
    name: student.user.name,
    email: student.user.email,
    levelId: student.levelId,
    levelCode: student.level?.code ?? null,
  }));
}

/** Active groups for the "Add to group" pickers, with free places. */
export async function groupPickerOptions(db: SchoolDb) {
  const groups = await db.group.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      type: true,
      capacity: true,
      levelId: true,
      level: { select: { code: true } },
      _count: { select: { memberships: ACTIVE_MEMBERS } },
    },
  });
  return groups.map(({ _count, level, ...group }) => ({
    ...group,
    levelCode: level.code,
    members: _count.memberships,
  }));
}

export type GroupPickerOption = Awaited<
  ReturnType<typeof groupPickerOptions>
>[number];

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export async function getGroup(db: SchoolDb, id: string, today: Date) {
  const group = await db.group.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      type: true,
      capacity: true,
      levelId: true,
      courseId: true,
      deletedAt: true,
      updatedAt: true,
      level: { select: { code: true, name: true, archivedAt: true } },
      course: { select: { name: true } },
      _count: { select: { lessons: true } },
      lessonTimes: {
        orderBy: [{ weekday: "asc" }, { startMinute: "asc" }],
        select: {
          id: true,
          weekday: true,
          startMinute: true,
          endMinute: true,
          roomId: true,
        },
      },
      memberships: {
        orderBy: { joinedAt: "asc" },
        select: {
          id: true,
          joinedAt: true,
          leftAt: true,
          student: {
            select: {
              id: true,
              levelId: true,
              level: { select: { code: true } },
              user: {
                select: { id: true, name: true, email: true, deletedAt: true },
              },
            },
          },
        },
      },
      timetableSlots: {
        where: activeSlotWhere(today),
        orderBy: [{ weekday: "asc" }, { startMinute: "asc" }],
        select: {
          id: true,
          weekday: true,
          startMinute: true,
          endMinute: true,
          validFrom: true,
          validUntil: true,
          term: { select: { id: true, name: true, startDate: true } },
          teacher: { select: { user: { select: { name: true } } } },
          room: { select: { name: true, archivedAt: true } },
        },
      },
    },
  });
  if (!group) return null;
  const members = group.memberships.map((membership) => ({
    id: membership.id,
    joinedAt: membership.joinedAt,
    leftAt: membership.leftAt,
    studentId: membership.student.id,
    userId: membership.student.user.id,
    name: membership.student.user.name,
    email: membership.student.user.email,
    archived: !!membership.student.user.deletedAt,
    levelCode: membership.student.level?.code ?? null,
    otherLevel: levelMismatch(membership.student.levelId, group.levelId),
  }));
  type Slot = {
    id: string;
    weekday: number;
    from: string;
    to: string;
    validFrom: Date | null;
    validUntil: Date | null;
    teacher: string;
    room: string | null;
    roomArchived: boolean;
  };
  const terms = new Map<
    string,
    { id: string; name: string; startDate: Date; slots: Slot[] }
  >();
  for (const slot of group.timetableSlots) {
    const term = terms.get(slot.term.id) ?? { ...slot.term, slots: [] };
    term.slots.push({
      id: slot.id,
      weekday: slot.weekday,
      from: formatMinutes(slot.startMinute),
      to: formatMinutes(slot.endMinute),
      validFrom: slot.validFrom,
      validUntil: slot.validUntil,
      teacher: slot.teacher.user.name,
      room: slot.room?.name ?? null,
      roomArchived: !!slot.room?.archivedAt,
    });
    terms.set(slot.term.id, term);
  }
  return {
    id: group.id,
    name: group.name,
    type: group.type,
    capacity: group.capacity,
    levelId: group.levelId,
    courseId: group.courseId,
    deletedAt: group.deletedAt,
    updatedAt: group.updatedAt,
    level: group.level,
    course: group.course,
    lessons: group._count.lessons,
    lessonTimes: group.lessonTimes,
    current: members.filter((member) => member.leftAt === null),
    past: members
      .filter((member) => member.leftAt !== null)
      .sort((a, b) => b.leftAt!.getTime() - a.leftAt!.getTime()),
    terms: [...terms.values()].sort(
      (a, b) => a.startDate.getTime() - b.startDate.getTime(),
    ),
  };
}

/**
 * Students who can be added: active, not already current members. Each
 * carries the level-mismatch flag and the first time clash with one of
 * their other groups (same term, weekday and overlapping time).
 */
export async function memberCandidates(
  db: SchoolDb,
  groupId: string,
  today: Date,
) {
  const group = await db.group.findUnique({
    where: { id: groupId },
    select: {
      levelId: true,
      timetableSlots: {
        where: activeSlotWhere(today),
        select: {
          termId: true,
          weekday: true,
          startMinute: true,
          endMinute: true,
        },
      },
    },
  });
  if (!group) return [];
  const students = await db.studentProfile.findMany({
    where: {
      user: { deletedAt: null },
      groupMemberships: { none: { groupId, leftAt: null } },
    },
    orderBy: { user: { name: "asc" } },
    select: {
      id: true,
      levelId: true,
      level: { select: { code: true } },
      user: { select: { name: true, email: true } },
      groupMemberships: {
        where: { ...CURRENT_MEMBERSHIP, groupId: { not: groupId } },
        select: {
          group: {
            select: {
              name: true,
              timetableSlots: {
                where: activeSlotWhere(today),
                select: {
                  termId: true,
                  weekday: true,
                  startMinute: true,
                  endMinute: true,
                },
              },
            },
          },
        },
      },
    },
  });
  return students.map((student) => ({
    id: student.id,
    name: student.user.name,
    email: student.user.email,
    levelId: student.levelId,
    levelCode: student.level?.code ?? null,
    otherLevel: levelMismatch(student.levelId, group.levelId),
    clash: timeClash(
      group.timetableSlots,
      student.groupMemberships.flatMap(({ group: other }) =>
        other.timetableSlots.map((slot) => ({
          ...slot,
          groupName: other.name,
        })),
      ),
    ),
  }));
}

export type MemberCandidate = Awaited<
  ReturnType<typeof memberCandidates>
>[number];

// ---------------------------------------------------------------------------
// Create / edit / archive
// ---------------------------------------------------------------------------

async function assertNameFree(db: SchoolDb, name: string, exceptId?: string) {
  const clash = await db.group.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw uniqueError("name", "groups.field.name", name);
}

async function assertCourse(db: SchoolDb, courseId: string | null) {
  if (!courseId) return;
  const course = await db.course.count({ where: { id: courseId } });
  if (!course) throw new AdminError(msg("common.error.notFound"), "courseId");
}

async function assertActiveStudent(
  db: SchoolDb | Tx,
  studentId: string,
  field: string,
) {
  const student = await db.studentProfile.findFirst({
    where: { id: studentId, user: { deletedAt: null } },
    select: { id: true },
  });
  if (!student) throw new AdminError(msg("common.error.notFound"), field);
}

export async function createGroup(
  scope: Scope,
  input: GroupInput,
  startDate: Date,
) {
  const { db, schoolId } = scope;
  await assertNameFree(db, input.name);
  await assertLevelPickable(db, input.levelId, "levelId");
  await assertCourse(db, input.courseId);
  if (input.studentId) {
    await assertActiveStudent(db, input.studentId, "studentId");
  }
  try {
    const group = await db.$transaction(async (tx) => {
      const created = await tx.group.create({
        data: {
          schoolId,
          name: input.name,
          type: input.type,
          levelId: input.levelId,
          courseId: input.courseId,
          capacity: input.capacity,
        },
        select: { id: true, name: true },
      });
      if (input.studentId) {
        await tx.groupMembership.create({
          data: {
            schoolId,
            groupId: created.id,
            studentId: input.studentId,
            joinedAt: startDate,
          },
        });
      }
      return created;
    });
    await audit(scope, "group.created", "Group", group.id, {
      type: input.type,
    });
    return group;
  } catch (error) {
    if (isUniqueViolation(error))
      throw uniqueError("name", "groups.field.name", input.name);
    throw error;
  }
}

/**
 * Edits a group. Type is locked once lessons exist; the capacity can't go
 * below the current member count (re-checked under the group lock).
 */
export async function updateGroup(scope: Scope, id: string, input: GroupInput) {
  const { db } = scope;
  const existing = await db.group.findUnique({
    where: { id },
    select: { id: true, type: true, levelId: true, updatedAt: true },
  });
  if (!existing) throw notFound();
  assertFresh(existing, input.updatedAt);
  await assertNameFree(db, input.name, id);
  await assertLevelPickable(db, input.levelId, "levelId", existing.levelId);
  await assertCourse(db, input.courseId);
  try {
    const group = await db.$transaction(async (tx) => {
      await lockGroup(tx, id);
      if (input.type !== existing.type) {
        const lessons = await tx.lesson.count({ where: { groupId: id } });
        if (!canChangeType(lessons)) {
          throw new AdminError(msg("groups.field.typeLocked"), "type");
        }
      }
      const members = await tx.groupMembership.count({
        where: { groupId: id, leftAt: null },
      });
      const error = capacityError(input.capacity, members);
      if (error) {
        throw new AdminError(
          error,
          input.type === "ONE_ON_ONE" ? "type" : "capacity",
        );
      }
      return tx.group.update({
        where: { id },
        data: {
          name: input.name,
          type: input.type,
          levelId: input.levelId,
          courseId: input.courseId,
          capacity: input.capacity,
        },
        select: { id: true, name: true },
      });
    });
    await audit(scope, "group.updated", "Group", id);
    return group;
  } catch (error) {
    if (isUniqueViolation(error))
      throw uniqueError("name", "groups.field.name", input.name);
    throw error;
  }
}

async function findGroup(db: SchoolDb, id: string) {
  const group = await db.group.findUnique({
    where: { id },
    select: { id: true, name: true, deletedAt: true },
  });
  if (!group) throw notFound();
  return group;
}

/** Blocked while the group has slots in a current or future term (§5.3). */
export async function archiveGroup(scope: Scope, id: string, today: Date) {
  const { db } = scope;
  const group = await findGroup(db, id);
  if (group.deletedAt) return group;
  const slots = await db.timetableSlot.findMany({
    where: { groupId: id, ...activeSlotWhere(today) },
    orderBy: [{ weekday: "asc" }, { startMinute: "asc" }],
    select: {
      weekday: true,
      startMinute: true,
      endMinute: true,
      term: { select: { name: true } },
    },
  });
  if (slots.length > 0) {
    throw blockedError({
      title: msg("common.blocked.archiveTitle", { name: group.name }),
      reason: msg("groups.blocked.hasSlots", { name: group.name }),
      items: slots.map((slot) =>
        msg("groups.blocked.slotItem", {
          weekday: msg(`common.weekdayShort.${slot.weekday}`),
          from: formatMinutes(slot.startMinute),
          to: formatMinutes(slot.endMinute),
          term: slot.term.name,
        }),
      ),
      link: {
        href: `/admin/timetable?group=${id}`,
        label: msg("groups.openInEditor"),
      },
    });
  }
  await db.group.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit(scope, "group.archived", "Group", id);
  return group;
}

export async function restoreGroup(scope: Scope, id: string) {
  const { db } = scope;
  const group = await findGroup(db, id);
  if (group.deletedAt) {
    await db.group.update({ where: { id }, data: { deletedAt: null } });
    await audit(scope, "group.restored", "Group", id);
  }
  return group;
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/**
 * Adds students to a group from `startDate`. Never overfills: the free
 * places are re-checked under the group lock. A former member's row is
 * reused (`joinedAt` = new start, `leftAt` cleared).
 */
export async function addMembers(
  scope: Scope,
  groupId: string,
  studentIds: string[],
  startDate: Date,
) {
  const { db, schoolId } = scope;
  const result = await db.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const group = await tx.group.findUnique({
      where: { id: groupId },
      select: { id: true, name: true, capacity: true, deletedAt: true },
    });
    if (!group) throw notFound();
    if (group.deletedAt) {
      throw new AdminError(msg("groups.error.archived", { name: group.name }));
    }
    const students = await tx.studentProfile.findMany({
      where: { id: { in: studentIds }, user: { deletedAt: null } },
      select: { id: true },
    });
    if (students.length !== new Set(studentIds).size) throw notFound();
    const existing = await tx.groupMembership.findMany({
      where: { groupId },
      select: { id: true, studentId: true, leftAt: true },
    });
    const plan = planAddMembers({
      capacity: group.capacity,
      existing,
      requested: studentIds,
    });
    if (!plan.ok) throw new AdminError(plan.error);
    if (plan.create.length > 0) {
      await tx.groupMembership.createMany({
        data: plan.create.map((studentId) => ({
          schoolId,
          groupId,
          studentId,
          joinedAt: startDate,
        })),
      });
    }
    for (const { membershipId } of plan.rejoin) {
      await tx.groupMembership.update({
        where: { id: membershipId },
        data: { joinedAt: startDate, leftAt: null },
      });
    }
    return { group, count: plan.create.length + plan.rejoin.length };
  });
  await audit(scope, "group.members_added", "Group", groupId, {
    studentIds,
  });
  return result;
}

/** Sets `leftAt` (never deletes): the student's lesson history stays. */
export async function removeMember(
  scope: Scope,
  membershipId: string,
  date: Date,
  today: Date,
) {
  const { db } = scope;
  const membership = await db.groupMembership.findUnique({
    where: { id: membershipId },
    select: {
      id: true,
      groupId: true,
      joinedAt: true,
      leftAt: true,
      group: { select: { name: true } },
      student: { select: { user: { select: { name: true } } } },
    },
  });
  if (!membership) throw notFound();
  const error = removalError({
    joinedAt: membership.joinedAt,
    leftAt: membership.leftAt,
    date,
    today,
  });
  if (error) throw new AdminError(error, "date");
  await db.groupMembership.update({
    where: { id: membershipId },
    data: { leftAt: date },
  });
  await audit(scope, "group.member_removed", "Group", membership.groupId, {
    membershipId,
  });
  return {
    group: membership.group.name,
    student: membership.student.user.name,
  };
}

// ---------------------------------------------------------------------------
// Lesson times (timetable-generator.md §5.1, generator.md §2.1)
// ---------------------------------------------------------------------------

/** Rooms for the lesson-time rows: physical first, then online; by name. */
export async function lessonTimeRooms(db: SchoolDb): Promise<RoomInfo[]> {
  const rooms = await db.room.findMany({
    select: {
      id: true,
      name: true,
      kind: true,
      capacity: true,
      archivedAt: true,
    },
  });
  return rooms
    .map((room) => ({
      id: room.id,
      name: room.name,
      online: room.kind === "ONLINE",
      capacity: room.capacity,
      archived: room.archivedAt !== null,
    }))
    .sort(
      (a, b) =>
        Number(a.online) - Number(b.online) || a.name.localeCompare(b.name),
    );
}

/**
 * Replaces a group's lesson times. Never touches live slots (Q2): the
 * generator reads them the next time teachers are assigned. A physical room
 * used by another active group at an overlapping time refuses the save.
 */
export async function saveLessonTimes(
  scope: Scope,
  groupId: string,
  input: LessonTimesInput,
) {
  const { db, schoolId } = scope;
  return db.$transaction(async (tx) => {
    // Serialised per school, so two groups can't take the same room at once.
    const key = `group-lesson-times:${schoolId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    const group = await tx.group.findUnique({
      where: { id: groupId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (!group) throw notFound();
    if (group.deletedAt) {
      throw new AdminError(msg("groups.lessonTimes.archived"));
    }
    const roomIds = [...new Set(input.times.map((t) => t.roomId))];
    const rooms = await tx.room.findMany({
      where: { id: { in: roomIds } },
      select: { id: true, name: true, kind: true, archivedAt: true },
    });
    const roomById = new Map(
      rooms.map((room) => [
        room.id,
        {
          id: room.id,
          name: room.name,
          online: room.kind === "ONLINE",
          capacity: null,
          archived: room.archivedAt !== null,
        },
      ]),
    );
    for (const [index, time] of input.times.entries()) {
      const room = roomById.get(time.roomId);
      if (!room || room.archived) {
        throw new AdminError(
          msg("validation.select", {
            field: msg("groups.lessonTimes.room"),
          }),
          `times.${index}.roomId`,
        );
      }
    }
    const others = await tx.groupLessonTime.findMany({
      where: {
        roomId: { in: roomIds },
        groupId: { not: groupId },
        group: { deletedAt: null },
      },
      select: {
        groupId: true,
        weekday: true,
        startMinute: true,
        endMinute: true,
        roomId: true,
        group: { select: { name: true } },
      },
    });
    const clash = roomClashes(
      input.times,
      others.map(({ group: other, ...time }) => ({
        ...time,
        groupName: other.name,
      })),
      roomById,
    )[0];
    if (clash) {
      throw new AdminError(
        msg("groups.lessonTimes.roomClash", {
          room: roomById.get(clash.roomId)!.name,
          group: clash.otherGroupName,
          weekday: msg(`common.weekday.${clash.weekday}`),
          from: formatMinutes(clash.startMinute),
          to: formatMinutes(clash.endMinute),
        }),
        `times.${clash.index}.roomId`,
      );
    }
    await tx.groupLessonTime.deleteMany({ where: { groupId } });
    if (input.times.length > 0) {
      await tx.groupLessonTime.createMany({
        data: input.times.map((time) => ({ schoolId, groupId, ...time })),
      });
    }
    await tx.auditLog.create({
      data: {
        schoolId,
        actorId: scope.actor.userId,
        action: "group.lesson_times_updated",
        entityType: "Group",
        entityId: groupId,
        data: { times: input.times },
      },
    });
    return { name: group.name };
  });
}
