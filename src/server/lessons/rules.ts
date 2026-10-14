// Pure rules for the lesson log (docs/design/lessons.md §5, §11–12): when a
// log can be written, which badge a lesson shows, how a save is applied and
// which lessons a list filter shows. No Prisma, no Next.js.

export const COVERED_MAX = 5_000;
export const HOMEWORK_MAX = 2_000;
export const NOTE_MAX = 2_000;

/** Counters appear within 10 % of the limit (§9). */
export const counterFrom = (max: number) => Math.floor(max * 0.9);

export type LessonStatus = "SCHEDULED" | "CANCELLED" | "COMPLETED";

type Timed = { startsAt: Date; endsAt: Date; status: LessonStatus };

export const hasStarted = (lesson: { startsAt: Date }, now: Date) =>
  lesson.startsAt.getTime() <= now.getTime();

export const hasEnded = (lesson: { endsAt: Date }, now: Date) =>
  lesson.endsAt.getTime() <= now.getTime();

/**
 * Why the log of a lesson can't be written right now, or null when it can:
 * only from the lesson's start time onwards, never on a cancelled lesson
 * (§5.2, decision §12.2).
 */
export function logLock(
  lesson: Timed,
  now: Date,
): "cancelled" | "notStarted" | null {
  if (lesson.status === "CANCELLED") return "cancelled";
  if (!hasStarted(lesson, now)) return "notStarted";
  return null;
}

/**
 * The page badge (§5.2): "Cancelled", or "No log yet" once the lesson has
 * ended without a "What we covered" text. No badge otherwise.
 */
export function lessonBadge(
  lesson: Timed,
  log: { content: string | null } | null,
  now: Date,
): "cancelled" | "noLog" | null {
  if (lesson.status === "CANCELLED") return "cancelled";
  if (hasEnded(lesson, now) && !log?.content) return "noLog";
  return null;
}

/** How the signed-in teacher relates to a lesson they can open. */
export type TeacherRelation = "regular" | "substituting" | "covered";

export function teacherRelation(
  lesson: { teacherId: string; substituteTeacherId: string | null },
  teacherId: string,
): TeacherRelation {
  if (lesson.substituteTeacherId === teacherId) return "substituting";
  return lesson.substituteTeacherId ? "covered" : "regular";
}

export type LogTexts = { content: string | null; homework: string | null };

/**
 * What saving the form does to the stored record: both fields empty removes
 * it (§11), otherwise it is created or updated. Saving an empty form when
 * there is no record changes nothing.
 */
export function logWrite(
  input: LogTexts,
  exists: boolean,
): "create" | "update" | "delete" | "none" {
  const empty = input.content === null && input.homework === null;
  if (empty) return exists ? "delete" : "none";
  return exists ? "update" : "create";
}

/**
 * Optimistic concurrency (§5.2 "Two teachers editing"): the save is refused
 * when the stored record isn't the one the form was loaded with. Both are
 * the record's `updatedAt` as an ISO string, or null for "no record".
 */
export function isStale(
  expectedUpdatedAt: string | null,
  current: { updatedAt: Date } | null,
): boolean {
  return (current?.updatedAt.toISOString() ?? null) !== expectedUpdatedAt;
}

export const LESSON_FILTERS = ["noLog", "upcoming", "past"] as const;
export type LessonFilter = (typeof LESSON_FILTERS)[number];

export function parseLessonFilter(value: string | undefined): LessonFilter {
  return LESSON_FILTERS.includes(value as LessonFilter)
    ? (value as LessonFilter)
    : "noLog";
}

/** Whether a lesson belongs in a list filter (§5.4). */
export function matchesFilter(
  filter: LessonFilter,
  lesson: Timed,
  log: { content: string | null } | null,
  now: Date,
): boolean {
  switch (filter) {
    case "noLog":
      return lessonBadge(lesson, log, now) === "noLog";
    case "upcoming":
      return !hasStarted(lesson, now);
    case "past":
      return hasStarted(lesson, now);
  }
}

/** "Earlier notes" are shown 10 at a time (§5.3). */
export const EARLIER_NOTES_PAGE = 10;

/** The teacher dashboard To do card (§5.1): ≤ 5 lessons of the last 14 days. */
export const TODO_LIMIT = 5;
export const TODO_DAYS = 14;
