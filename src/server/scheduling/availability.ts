import { isoWeekday, type IsoDate } from "./time";
import type { AvailabilityRule } from "./types";

/**
 * The availability rules that make `teacherId` unavailable for the window
 * `[startMinute, endMinute)` on `date`:
 *
 * - `DATE_UNAVAILABLE` on that date, whole day or overlapping the window;
 * - `WEEKLY_UNAVAILABLE` on that weekday overlapping the window, unless a
 *   `DATE_AVAILABLE` exception on that date (whole day or covering the whole
 *   window) lifts it. Exceptions never lift a `DATE_UNAVAILABLE` rule.
 */
export function unavailabilityRules(
  rules: readonly AvailabilityRule[],
  teacherId: string,
  date: IsoDate,
  startMinute: number,
  endMinute: number,
): AvailabilityRule[] {
  const overlaps = (rule: AvailabilityRule) =>
    rule.startMinute === null ||
    rule.endMinute === null ||
    (rule.startMinute < endMinute && startMinute < rule.endMinute);
  const covers = (rule: AvailabilityRule) =>
    rule.startMinute === null ||
    rule.endMinute === null ||
    (rule.startMinute <= startMinute && endMinute <= rule.endMinute);

  const own = rules.filter((rule) => rule.teacherId === teacherId);
  const onDate = own.filter((rule) => rule.date === date);
  const hits = onDate.filter(
    (rule) => rule.kind === "DATE_UNAVAILABLE" && overlaps(rule),
  );
  const lifted = onDate.some(
    (rule) => rule.kind === "DATE_AVAILABLE" && covers(rule),
  );
  if (!lifted) {
    const weekday = isoWeekday(date);
    hits.push(
      ...own.filter(
        (rule) =>
          rule.kind === "WEEKLY_UNAVAILABLE" &&
          rule.weekday === weekday &&
          overlaps(rule),
      ),
    );
  }
  return hits;
}
