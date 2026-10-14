/** Calendar date without time, as "YYYY-MM-DD". */
export type IsoDate = string;

/** Converts a `@db.Date` value (UTC midnight) to "YYYY-MM-DD". */
export function toIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

/** Parses "YYYY-MM-DD" as a `@db.Date`-compatible value (UTC midnight). */
export function fromIsoDate(isoDate: IsoDate): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

export function addDays(isoDate: IsoDate, days: number): IsoDate {
  const date = fromIsoDate(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(isoDate: IsoDate): number {
  const day = fromIsoDate(isoDate).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Formats minutes since midnight as "HH:MM". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Offset of `timeZone` from UTC at `instant`, in minutes (e.g. +120 for CEST). */
function timeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * The instant at which the wall-clock time `minutes` after midnight on
 * `isoDate` occurs in `timeZone`. Handles DST shifts:
 * - a wall-clock time in the spring-forward gap (e.g. 02:30 on the last
 *   Sunday of March in Europe) does not exist and is shifted forward by the
 *   gap (→ 03:30 summer time);
 * - an ambiguous time in the fall-back overlap resolves to the later
 *   (standard-time) instant.
 */
export function zonedTimeToUtc(
  isoDate: IsoDate,
  minutes: number,
  timeZone: string,
): Date {
  const wallClockAsUtc = fromIsoDate(isoDate).getTime() + minutes * 60_000;
  let instant = wallClockAsUtc;
  // Two passes settle the offset even when the guess lands across a DST switch.
  for (let i = 0; i < 2; i++) {
    const offset = timeZoneOffsetMinutes(new Date(instant), timeZone);
    instant = wallClockAsUtc - offset * 60_000;
  }
  return new Date(instant);
}
