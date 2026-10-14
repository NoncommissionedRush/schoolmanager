/**
 * Locale- and time-zone-aware date helpers for timetables.
 *
 * Calendar days are handled as `CalendarDate` strings ("2026-10-14") so a
 * week never shifts by a day because of the server's or browser's time zone.
 * Convert an instant to the school's calendar day with `toCalendarDate`.
 */

/** Day of the week, 0 = Sunday … 6 = Saturday (same as `Date#getDay`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** An ISO calendar date without time or zone, e.g. "2026-10-14". */
export type CalendarDate = string;

/** Weeks start on Monday unless a school configures otherwise. */
export const DEFAULT_WEEK_START: Weekday = 1;

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(date: CalendarDate): Date {
  const match = CALENDAR_DATE.exec(date);
  if (!match) throw new RangeError(`Invalid calendar date: ${date}`);
  const [, y, m, d] = match.map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (utc.getUTCMonth() !== m - 1) {
    throw new RangeError(`Invalid calendar date: ${date}`);
  }
  return utc;
}

function format(utc: Date): CalendarDate {
  return utc.toISOString().slice(0, 10);
}

/** The calendar day an instant falls on in the given IANA time zone. */
export function toCalendarDate(instant: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function weekdayOf(date: CalendarDate): Weekday {
  return parse(date).getUTCDay() as Weekday;
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const utc = parse(date);
  utc.setUTCDate(utc.getUTCDate() + days);
  return format(utc);
}

/** First day of the week containing `date`. */
export function startOfWeek(
  date: CalendarDate,
  weekStartsOn: Weekday = DEFAULT_WEEK_START,
): CalendarDate {
  const offset = (weekdayOf(date) - weekStartsOn + 7) % 7;
  return addDays(date, -offset);
}

/** The seven calendar dates of the week containing `date`, in order. */
export function weekDates(
  date: CalendarDate,
  weekStartsOn: Weekday = DEFAULT_WEEK_START,
): CalendarDate[] {
  const start = startOfWeek(date, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Weekdays in display order, e.g. Mon…Sun for a Monday start. */
export function orderedWeekdays(
  weekStartsOn: Weekday = DEFAULT_WEEK_START,
): Weekday[] {
  return Array.from(
    { length: 7 },
    (_, i) => ((weekStartsOn + i) % 7) as Weekday,
  );
}

/** Localised weekday name, e.g. "Monday" / "Mon" / "M". */
export function weekdayName(
  locale: string,
  weekday: Weekday,
  width: "long" | "short" | "narrow" = "long",
): string {
  // 2026-01-04 is a Sunday; offset from it to reach the requested weekday.
  const reference = new Date(Date.UTC(2026, 0, 4 + weekday));
  return new Intl.DateTimeFormat(locale, {
    weekday: width,
    timeZone: "UTC",
  }).format(reference);
}

/** Localised weekday names in display order. */
export function weekdayNames(
  locale: string,
  weekStartsOn: Weekday = DEFAULT_WEEK_START,
  width: "long" | "short" | "narrow" = "long",
): string[] {
  return orderedWeekdays(weekStartsOn).map((day) =>
    weekdayName(locale, day, width),
  );
}

/** Formats a calendar date, e.g. "14 Oct 2026" for en-GB. */
export function formatCalendarDate(
  locale: string,
  date: CalendarDate,
  options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
  },
): string {
  return new Intl.DateTimeFormat(locale, {
    ...options,
    timeZone: "UTC",
  }).format(parse(date));
}

/** Week label for a timetable toolbar, e.g. "13–19 Oct 2026" for en-GB. */
export function formatWeekRange(
  locale: string,
  start: CalendarDate,
  end: CalendarDate = addDays(start, 6),
): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).formatRange(parse(start), parse(end));
}

/** Lesson time range in the school's time zone, e.g. "09:30–11:00". */
export function formatTimeRange(
  locale: string,
  start: Date,
  end: Date,
  timeZone: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).formatRange(start, end);
}
