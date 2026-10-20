import {
  addDays,
  daysBetween,
  type IsoDate,
  toZonedDateTime,
} from "../../src/server/scheduling/time";

/**
 * The seed's dates are written around this day (a Wednesday): lessons
 * before it are history, the absences and covers after it are upcoming.
 */
export const BASE_TODAY = "2026-10-14";

/** The first day of the seeded terms as written; e2e reads the shift from it. */
export const BASE_TERM_START = "2026-09-14";

/**
 * Whole weeks, in days, that every seeded date moves by, so the seed's
 * "today" is the latest Wednesday on or before `reference`. Weekdays stay
 * put, and every upcoming event in the seed is at least 7 days after
 * BASE_TODAY, so it is still upcoming on any day of the reference week.
 */
export function seedShiftDays(reference: IsoDate): number {
  return Math.floor(daysBetween(BASE_TODAY, reference) / 7) * 7;
}

/**
 * The reference day: `SEED_TODAY` (YYYY-MM-DD) when set, so a seed can be
 * pinned to a fixed date, else today in the demo school's time zone.
 */
function referenceDay(): IsoDate {
  const pinned = process.env.SEED_TODAY;
  if (pinned) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pinned)) {
      throw new Error(`SEED_TODAY must be YYYY-MM-DD, got "${pinned}"`);
    }
    return pinned;
  }
  return toZonedDateTime(new Date(), "Europe/Bratislava").date;
}

export const SEED_SHIFT_DAYS = seedShiftDays(referenceDay());

/** A date of the seed as written, moved to the reference week. */
export const seedDate = (isoDate: IsoDate) => addDays(isoDate, SEED_SHIFT_DAYS);

/** The date as written for a moved date (keeps row ids stable on re-seed). */
export const baseDate = (isoDate: IsoDate) =>
  addDays(isoDate, -SEED_SHIFT_DAYS);
