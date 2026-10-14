// Pure rules for what students see of lessons (docs/design/lessons.md §2,
// §6, §10): which lessons, how the Homework tab pages and groups them, and
// which homework the home card shows. No Prisma, no Next.js.

import { isMemberAt, type MembershipWindow } from "@/server/timetable/week";

import { hasStarted } from "./rules";

/** The Homework tab loads 20 more lessons per "Load more" (§6.2). */
export const HOMEWORK_PAGE = 20;
/** Upper bound for `?shown=`, so a URL can't ask for the whole history. */
export const HOMEWORK_MAX_SHOWN = 1_000;

/** How many lessons the Homework tab shows, from `?shown=`. */
export function parseShown(value: string | undefined): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n) || n < HOMEWORK_PAGE) return HOMEWORK_PAGE;
  const pages = Math.ceil(n / HOMEWORK_PAGE);
  return Math.min(pages * HOMEWORK_PAGE, HOMEWORK_MAX_SHOWN);
}

/**
 * Whether a student may open a lesson (§2): it belongs to a group they were
 * a member of when it started, its term is published, and it has started.
 * Anything else is "not found".
 */
export function canStudentSeeLesson(
  memberships: readonly MembershipWindow[],
  lesson: { groupId: string; startsAt: Date; published: boolean },
  now: Date,
): boolean {
  return (
    lesson.published &&
    hasStarted(lesson, now) &&
    isMemberAt(memberships, lesson.groupId, lesson.startsAt)
  );
}

/**
 * Consecutive items of the same month (`YYYY-MM` of `date`), in the given
 * order — the Homework tab's month headings (§6.2).
 */
export function groupByMonth<T extends { date: string }>(
  items: readonly T[],
): { month: string; items: T[] }[] {
  const groups: { month: string; items: T[] }[] = [];
  for (const item of items) {
    const month = item.date.slice(0, 7);
    const last = groups.at(-1);
    if (last?.month === month) last.items.push(item);
    else groups.push({ month, items: [item] });
  }
  return groups;
}

/** The home card shows at most 3 groups (§6.3). */
export const LATEST_HOMEWORK_LIMIT = 3;

/**
 * The home card (§6.3): the homework of each group's most recent lesson,
 * newest first, up to 3. A group whose last lesson set no homework is left
 * out. `latest` holds each group's most recent started, non-cancelled
 * lesson (or none).
 */
export function pickLatestHomework<
  T extends { startsAt: Date; homework: string | null },
>(latest: readonly (T | null)[]): (T & { homework: string })[] {
  return latest
    .filter((l): l is T & { homework: string } => !!l?.homework)
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
    .slice(0, LATEST_HOMEWORK_LIMIT);
}
