import {
  addDays,
  fromIsoDate,
  toIsoDate,
  toZonedDateTime,
  zonedTimeToUtc,
} from "@/server/scheduling/time";

import { AdminError, msg } from "../result";
import { audit, notFound, type SchoolDb, type Scope } from "../shared";
import { affectedLessons, mergeWeekly } from "./rules";
import type { ExceptionInput, WeeklyInput } from "./schema";

/**
 * Teacher availability (§6.4): weekly unavailability (merged per weekday on
 * save) and one-off exceptions. `teacherId` is the `TeacherProfile` id;
 * every query goes through the school-scoped client.
 */

async function assertTeacher(db: SchoolDb, teacherId: string) {
  const teacher = await db.teacherProfile.findUnique({
    where: { id: teacherId },
    select: { id: true },
  });
  if (!teacher) throw notFound();
}

export async function listAvailability(db: SchoolDb, teacherId: string) {
  const rows = await db.teacherAvailability.findMany({
    where: { teacherId },
    orderBy: [{ weekday: "asc" }, { date: "asc" }, { startMinute: "asc" }],
    select: {
      id: true,
      kind: true,
      weekday: true,
      date: true,
      startMinute: true,
      endMinute: true,
      note: true,
    },
  });
  const weekly = rows
    .filter((row) => row.kind === "WEEKLY_UNAVAILABLE")
    .map((row) => ({
      id: row.id,
      weekday: row.weekday ?? 1,
      startMinute: row.startMinute ?? 0,
      endMinute: row.endMinute ?? 0,
      note: row.note,
    }));
  const exceptions = rows
    .filter((row) => row.kind !== "WEEKLY_UNAVAILABLE" && row.date)
    .map((row) => ({
      id: row.id,
      kind: row.kind as "DATE_UNAVAILABLE" | "DATE_AVAILABLE",
      date: toIsoDate(row.date!),
      startMinute: row.startMinute,
      endMinute: row.endMinute,
      note: row.note,
    }));
  return { weekly, exceptions };
}

/**
 * Saves weekly unavailability for each chosen weekday. Overlapping (or
 * touching) rules on the same weekday are merged into one row. `replaceId`
 * = edit: that row is replaced. Returns the weekdays where a merge happened
 * (for the "Merged with an existing time on {weekday}" toast).
 */
export async function saveWeekly(
  scope: Scope,
  teacherId: string,
  input: WeeklyInput,
  replaceId: string | null,
) {
  const { db, schoolId } = scope;
  await assertTeacher(db, teacherId);
  // One transaction: an edit never leaves the old row deleted without
  // its replacement, and merges see a consistent day.
  const mergedWeekdays = await db.$transaction(async (tx) => {
    const mergedDays: number[] = [];
    if (replaceId) {
      const { count } = await tx.teacherAvailability.deleteMany({
        where: { id: replaceId, teacherId, kind: "WEEKLY_UNAVAILABLE" },
      });
      if (count === 0) throw notFound();
    }
    for (const weekday of input.weekdays) {
      const existing = await tx.teacherAvailability.findMany({
        where: { teacherId, kind: "WEEKLY_UNAVAILABLE", weekday },
        select: { id: true, startMinute: true, endMinute: true, note: true },
      });
      const merged = mergeWeekly(
        existing.map((row) => ({
          id: row.id,
          startMinute: row.startMinute ?? 0,
          endMinute: row.endMinute ?? 0,
          note: row.note,
        })),
        input,
      );
      if (merged.absorbedIds.length > 0) {
        mergedDays.push(weekday);
        await tx.teacherAvailability.deleteMany({
          where: { id: { in: merged.absorbedIds }, teacherId },
        });
      }
      await tx.teacherAvailability.create({
        data: {
          schoolId,
          teacherId,
          kind: "WEEKLY_UNAVAILABLE",
          weekday,
          startMinute: merged.startMinute,
          endMinute: merged.endMinute,
          note: merged.note,
        },
      });
    }
    return mergedDays;
  });
  await audit(scope, "availability.weekly_saved", "TeacherProfile", teacherId, {
    weekdays: input.weekdays,
    startMinute: input.startMinute,
    endMinute: input.endMinute,
  });
  return { mergedWeekdays };
}

/**
 * Saves a one-off exception (one row per date). For unavailability, returns
 * how many scheduled lessons of the teacher it affects — P1 doesn't change
 * them, it only makes the conflict visible (§6.4).
 */
export async function saveException(
  scope: Scope,
  teacherId: string,
  input: ExceptionInput,
  timezone: string,
) {
  const { db, schoolId } = scope;
  await assertTeacher(db, teacherId);
  if (input.dates.length === 0) {
    throw new AdminError(msg("availability.error.rangeTooLong"), "dateTo");
  }
  await db.teacherAvailability.createMany({
    data: input.dates.map((date) => ({
      schoolId,
      teacherId,
      kind: input.kind,
      date: fromIsoDate(date),
      startMinute: input.window?.startMinute ?? null,
      endMinute: input.window?.endMinute ?? null,
      note: input.note,
    })),
  });
  await audit(
    scope,
    "availability.exception_saved",
    "TeacherProfile",
    teacherId,
    {
      kind: input.kind,
      from: input.dates[0],
      to: input.dates.at(-1) ?? input.dates[0],
    },
  );
  const affected =
    input.kind === "DATE_UNAVAILABLE"
      ? await countAffectedLessons(db, teacherId, input, timezone)
      : 0;
  return { affected };
}

async function countAffectedLessons(
  db: SchoolDb,
  teacherId: string,
  input: ExceptionInput,
  timezone: string,
) {
  const first = input.dates[0];
  const last = input.dates.at(-1) ?? first;
  const lessons = await db.lesson.findMany({
    where: {
      status: "SCHEDULED",
      OR: [{ teacherId }, { substituteTeacherId: teacherId }],
      startsAt: {
        gte: zonedTimeToUtc(first, 0, timezone),
        lt: zonedTimeToUtc(addDays(last, 1), 0, timezone),
      },
    },
    select: { startsAt: true, endsAt: true },
  });
  const local = lessons.map((lesson) => {
    const start = toZonedDateTime(lesson.startsAt, timezone);
    const end = toZonedDateTime(lesson.endsAt, timezone);
    return {
      date: start.date,
      startMinute: start.minute,
      endMinute: end.date === start.date ? end.minute : 1440,
    };
  });
  return affectedLessons(local, input.dates, input.window).length;
}

/** Deletes one availability rule of this teacher (always allowed, §5.3). */
export async function deleteAvailability(
  scope: Scope,
  teacherId: string,
  id: string,
) {
  const { count } = await scope.db.teacherAvailability.deleteMany({
    where: { id, teacherId },
  });
  if (count === 0) throw notFound();
  await audit(scope, "availability.deleted", "TeacherProfile", teacherId, {
    ruleId: id,
  });
}
