import { addDays, type IsoDate, isoWeekday, zonedTimeToUtc } from "./time";

export type { IsoDate };

export type SlotTemplate = {
  id: string;
  groupId: string;
  teacherId: string;
  roomId: string | null;
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
  startMinute: number;
  endMinute: number;
  /**
   * First and last date (inclusive) the slot is in effect; null = from the
   * term start / until the term end. See docs/architecture/scheduling.md.
   */
  validFrom?: IsoDate | null;
  validUntil?: IsoDate | null;
};

export type DateRange = { startDate: IsoDate; endDate: IsoDate };

export type LessonOccurrence = {
  timetableSlotId: string;
  groupId: string;
  teacherId: string;
  roomId: string | null;
  /** Local date of the occurrence; persist as `Lesson.occurrenceDate`. */
  date: IsoDate;
  startsAt: Date;
  endsAt: Date;
};

export type GenerateLessonsInput = {
  slots: readonly SlotTemplate[];
  /** Term dates, inclusive. */
  term: DateRange;
  /**
   * Days without lessons, inclusive ranges: the term's own holidays and the
   * school-wide ones (`Holiday.termId` null).
   */
  holidays: readonly DateRange[];
  /** IANA timezone the slot times are expressed in. */
  timeZone: string;
  /** Optional sub-range to generate (e.g. only the first weeks); clipped to the term. */
  range?: Partial<DateRange>;
};

/** Locale-independent string order, so output never depends on the ICU build. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isHoliday(
  date: IsoDate,
  holidays: readonly DateRange[],
): boolean {
  return holidays.some((h) => h.startDate <= date && date <= h.endDate);
}

/** Whether `slot` is in effect on `date` (ignores weekday and holidays). */
export function isSlotInEffect(
  slot: Pick<SlotTemplate, "validFrom" | "validUntil">,
  date: IsoDate,
): boolean {
  return (
    (!slot.validFrom || slot.validFrom <= date) &&
    (!slot.validUntil || date <= slot.validUntil)
  );
}

/**
 * The dates on which `slot` produces a lesson: its weekday within the term
 * and its validity range, minus holidays.
 */
export function slotOccurrenceDates(
  slot: Pick<SlotTemplate, "weekday" | "validFrom" | "validUntil">,
  term: DateRange,
  holidays: readonly DateRange[],
): IsoDate[] {
  let from = term.startDate;
  if (slot.validFrom && slot.validFrom > from) from = slot.validFrom;
  let to = term.endDate;
  if (slot.validUntil && slot.validUntil < to) to = slot.validUntil;
  if (from > to) return [];
  // Jump to the first matching weekday, then step a week at a time.
  const first = addDays(from, (slot.weekday - isoWeekday(from) + 7) % 7);
  const dates: IsoDate[] = [];
  for (let date = first; date <= to; date = addDays(date, 7)) {
    if (!isHoliday(date, holidays)) dates.push(date);
  }
  return dates;
}

/**
 * The lesson `slot` produces on `date`. `endsAt` is `startsAt` plus the
 * slot's duration, so a lesson keeps its length on DST switch days (see
 * `zonedTimeToUtc` for the gap behaviour).
 */
export function occurrenceOf(
  slot: SlotTemplate,
  date: IsoDate,
  timeZone: string,
): LessonOccurrence {
  const startsAt = zonedTimeToUtc(date, slot.startMinute, timeZone);
  const durationMs = (slot.endMinute - slot.startMinute) * 60_000;
  return {
    timetableSlotId: slot.id,
    groupId: slot.groupId,
    teacherId: slot.teacherId,
    roomId: slot.roomId,
    date,
    startsAt,
    endsAt: new Date(startsAt.getTime() + durationMs),
  };
}

/**
 * Expands recurring timetable slots into concrete dated lesson occurrences for
 * every day of the term that is not a holiday and on which the slot is in
 * effect (`validFrom`/`validUntil`). Pure: persisting is the
 * caller's job: store `date` as `Lesson.occurrenceDate`; lessons are unique
 * per `[timetableSlotId, occurrenceDate]`, so re-running is idempotent even
 * after a slot or lesson time has been edited.
 */
export function generateLessonOccurrences({
  slots,
  term,
  holidays,
  timeZone,
  range,
}: GenerateLessonsInput): LessonOccurrence[] {
  const from =
    range?.startDate && range.startDate > term.startDate
      ? range.startDate
      : term.startDate;
  const to =
    range?.endDate && range.endDate < term.endDate
      ? range.endDate
      : term.endDate;

  const occurrences: LessonOccurrence[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (isHoliday(date, holidays)) continue;
    const weekday = isoWeekday(date);
    for (const slot of slots) {
      if (slot.weekday !== weekday || !isSlotInEffect(slot, date)) continue;
      occurrences.push(occurrenceOf(slot, date, timeZone));
    }
  }
  return occurrences.sort(
    (a, b) =>
      a.startsAt.getTime() - b.startsAt.getTime() ||
      compareStrings(a.timetableSlotId, b.timetableSlotId),
  );
}
