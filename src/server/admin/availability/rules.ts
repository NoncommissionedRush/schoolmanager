import {
  addDays,
  daysBetween,
  type IsoDate,
  isoWeekday,
} from "@/server/scheduling/time";

/**
 * Pure rules behind the availability tab (§6.4). No Prisma, no Next.js:
 * the service and the client dialog both use them.
 */

/** Longest one-off exception range, in days (inclusive). */
export const MAX_EXCEPTION_DAYS = 31;

export type Window = { startMinute: number; endMinute: number };

export type WeeklyRow = Window & { id: string; note: string | null };

/**
 * Merges a new weekly window with the existing rules of the same weekday
 * (§6.4 "overlapping rules on the same day are merged on save"). Windows
 * that overlap or touch (07:00–09:00 + 09:00–12:00) become one. Merging can
 * cascade: the grown window may reach further rules, so it repeats until
 * stable. The note of the new window wins; otherwise the first absorbed
 * note is kept.
 */
export function mergeWeekly(
  existing: readonly WeeklyRow[],
  added: Window & { note: string | null },
): Window & { note: string | null; absorbedIds: string[] } {
  let { startMinute, endMinute } = added;
  let note = added.note;
  const absorbed = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of existing) {
      if (absorbed.has(row.id)) continue;
      if (row.startMinute <= endMinute && startMinute <= row.endMinute) {
        absorbed.add(row.id);
        startMinute = Math.min(startMinute, row.startMinute);
        endMinute = Math.max(endMinute, row.endMinute);
        note ??= row.note;
        changed = true;
      }
    }
  }
  return { startMinute, endMinute, note, absorbedIds: [...absorbed] };
}

/**
 * Every date from `from` to `to` (inclusive; `to` null = just `from`), or
 * null when the range is longer than {@link MAX_EXCEPTION_DAYS} or reversed.
 */
export function expandDateRange(
  from: IsoDate,
  to: IsoDate | null,
): IsoDate[] | null {
  const days = to ? daysBetween(from, to) + 1 : 1;
  if (days < 1 || days > MAX_EXCEPTION_DAYS) return null;
  return Array.from({ length: days }, (_, index) => addDays(from, index));
}

/**
 * A `DATE_AVAILABLE` exception only lifts weekly unavailability. True when
 * none of `dates` has a weekly rule overlapping `window` (null = whole day),
 * i.e. the exception would have no effect (§6.4 warning, not an error).
 */
export function availableExceptionHasNoEffect(
  dates: readonly IsoDate[],
  window: Window | null,
  weekly: readonly (Window & { weekday: number })[],
): boolean {
  if (dates.length === 0) return false;
  return dates.every(
    (date) =>
      !weekly.some(
        (rule) =>
          rule.weekday === isoWeekday(date) &&
          (window === null ||
            (rule.startMinute < window.endMinute &&
              window.startMinute < rule.endMinute)),
      ),
  );
}

/**
 * Lessons (in local date + minutes) that fall on one of `dates` and overlap
 * `window` (null = whole day) — the ones a new unavailability affects.
 */
export function affectedLessons<
  T extends { date: IsoDate; startMinute: number; endMinute: number },
>(lessons: readonly T[], dates: readonly IsoDate[], window: Window | null) {
  const days = new Set(dates);
  return lessons.filter(
    (lesson) =>
      days.has(lesson.date) &&
      (window === null ||
        (lesson.startMinute < window.endMinute &&
          window.startMinute < lesson.endMinute)),
  );
}
