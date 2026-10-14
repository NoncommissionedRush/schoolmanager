import { type ListParams, pageWindow, searchWhere, statusWhere } from "../list";
import {
  colorName,
  type CreateTeacherInput,
  nextUnusedColor,
  TEACHER_COLORS,
  type UpdateTeacherInput,
} from "../people/schema";
import { createPerson, updatePersonIdentity } from "../people/service";
import {
  activeSlotWhere,
  assertFresh,
  audit,
  notFound,
  type SchoolDb,
  type Scope,
} from "../shared";
import { pickCurrentTerm, teacherLoad } from "./load";

/**
 * Teachers (§6.1–6.3). Identity lives on the global `User` (written by
 * people/service.ts); everything else is read from the tenant side
 * (`TeacherProfile`) through the school-scoped client. The detail route
 * uses the `TeacherProfile` id, like the timetable and groups do.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value);

const userScalars = {
  select: { id: true, name: true, email: true, deletedAt: true },
} as const;

export async function listTerms(db: SchoolDb) {
  return db.term.findMany({
    orderBy: { startDate: "desc" },
    select: { id: true, name: true, startDate: true, endDate: true },
  });
}

export async function listTeachers(
  db: SchoolDb,
  filters: ListParams,
  today: Date,
) {
  const where = {
    user: statusWhere(filters.status, "deletedAt"),
    ...searchWhere(filters.q, ["user.name", "user.email"]),
  };
  const total = await db.teacherProfile.count({ where });
  const window = pageWindow(filters.page, total);
  const [profiles, terms, activeCount, anyCount, colors] = await Promise.all([
    db.teacherProfile.findMany({
      where,
      orderBy: { user: { name: "asc" } },
      skip: window.skip,
      take: window.take,
      select: { id: true, color: true, user: userScalars },
    }),
    listTerms(db),
    db.teacherProfile.count({ where: { user: { deletedAt: null } } }),
    db.teacherProfile.count(),
    db.teacherProfile.findMany({ select: { color: true } }),
  ]);
  const slots = await db.timetableSlot.findMany({
    where: {
      teacherId: { in: profiles.map((profile) => profile.id) },
      ...activeSlotWhere(today),
    },
    select: {
      teacherId: true,
      groupId: true,
      termId: true,
      validFrom: true,
      validUntil: true,
    },
  });
  const load = teacherLoad(slots, pickCurrentTerm(terms, today), today);
  return {
    teachers: profiles.map((profile) => ({
      id: profile.id,
      userId: profile.user.id,
      name: profile.user.name,
      email: profile.user.email,
      color: profile.color,
      archived: !!profile.user.deletedAt,
      groups: load.get(profile.id)?.groups ?? 0,
      lessonsPerWeek: load.get(profile.id)?.lessonsPerWeek ?? 0,
    })),
    total,
    window,
    activeCount,
    anyCount,
    nextColor: nextUnusedColor(colors.map((row) => row.color)),
  };
}

/** A teacher of this school by `TeacherProfile` id, or null. */
export async function getTeacher(db: SchoolDb, id: string) {
  if (!isUuid(id)) return null;
  const profile = await db.teacherProfile.findUnique({
    where: { id },
    select: {
      id: true,
      bio: true,
      color: true,
      updatedAt: true,
      user: userScalars,
    },
  });
  if (!profile) return null;
  return {
    id: profile.id,
    userId: profile.user.id,
    name: profile.user.name,
    email: profile.user.email,
    archived: !!profile.user.deletedAt,
    bio: profile.bio,
    color: profile.color,
    colorName: colorName(profile.color),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

export async function createTeacher(scope: Scope, input: CreateTeacherInput) {
  const { db, schoolId } = scope;
  const color =
    input.color ??
    nextUnusedColor(
      (await db.teacherProfile.findMany({ select: { color: true } })).map(
        (row) => row.color,
      ),
    );
  let teacherId = "";
  const userId = await createPerson(
    scope,
    "TEACHER",
    input,
    async (tx, userId) => {
      const profile = await tx.teacherProfile.create({
        data: { schoolId, userId, color: TEACHER_COLORS[color] },
        select: { id: true },
      });
      teacherId = profile.id;
    },
  );
  return { id: teacherId, userId, name: input.name };
}

/**
 * Profile tab (§6.3). An unchanged non-palette colour (seeded teachers) is
 * kept when no swatch is picked.
 */
export async function updateTeacher(
  scope: Scope,
  teacherId: string,
  input: UpdateTeacherInput,
) {
  const { db } = scope;
  const profile = await db.teacherProfile.findUnique({
    where: { id: teacherId },
    select: { id: true, userId: true, updatedAt: true },
  });
  if (!profile) throw notFound();
  assertFresh(profile, input.updatedAt);
  await updatePersonIdentity(scope, profile.userId, {
    name: input.name,
    email: input.email,
  });
  const updated = await db.teacherProfile.update({
    where: { id: teacherId },
    data: {
      bio: input.bio,
      ...(input.color ? { color: TEACHER_COLORS[input.color] } : {}),
    },
    select: { updatedAt: true },
  });
  await audit(scope, "teacher.updated", "TeacherProfile", teacherId);
  return { name: input.name, updatedAt: updated.updatedAt.toISOString() };
}

/**
 * Groups tab (§6.3): the teacher's slots in `termId`, one row per slot
 * (a group taught twice a week shows twice, with each time).
 */
export async function teacherSlots(
  db: SchoolDb,
  teacherId: string,
  termId: string,
) {
  const slots = await db.timetableSlot.findMany({
    where: { teacherId, termId },
    orderBy: [{ weekday: "asc" }, { startMinute: "asc" }],
    select: {
      id: true,
      weekday: true,
      startMinute: true,
      endMinute: true,
      validFrom: true,
      validUntil: true,
      group: {
        select: {
          id: true,
          name: true,
          deletedAt: true,
          level: { select: { code: true, name: true } },
        },
      },
      room: { select: { name: true } },
    },
  });
  return slots;
}

export { pickCurrentTerm };
