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

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round(
    (fromIsoDate(to).getTime() - fromIsoDate(from).getTime()) / 86_400_000,
  );
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

// Creating an Intl.DateTimeFormat is expensive; conflict checks convert
// thousands of instants, so keep one formatter per time zone.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock fields of `instant` in `timeZone`. */
function zonedParts(instant: Date, timeZone: string) {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in minutes (e.g. +120 for CEST). */
function timeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * Local calendar date and minutes since midnight of `instant` in `timeZone`,
 * e.g. 2026-10-14T15:30:00Z in Europe/Bratislava → 2026-10-14, 1050.
 */
export function toZonedDateTime(
  instant: Date,
  timeZone: string,
): { date: IsoDate; minute: number } {
  const p = zonedParts(instant, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    minute: p.hour * 60 + p.minute,
  };
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
  // Timetables repeat the same few dates and times over and over; the
  // Intl lookups below dominate conflict checks, so remember results.
  const key = `${timeZone}|${isoDate}|${minutes}`;
  let instant = zonedInstants.get(key);
  if (instant === undefined) {
    if (zonedInstants.size >= 100_000) zonedInstants.clear();
    instant = computeZonedTimeToUtc(isoDate, minutes, timeZone);
    zonedInstants.set(key, instant);
  }
  return new Date(instant);
}

const zonedInstants = new Map<string, number>();

function computeZonedTimeToUtc(
  isoDate: IsoDate,
  minutes: number,
  timeZone: string,
): number {
  const wallClockAsUtc = fromIsoDate(isoDate).getTime() + minutes * 60_000;
  let instant = wallClockAsUtc;
  // Two passes settle the offset even when the guess lands across a DST switch.
  for (let i = 0; i < 2; i++) {
    const offset = timeZoneOffsetMinutes(new Date(instant), timeZone);
    instant = wallClockAsUtc - offset * 60_000;
  }
  return instant;
}
