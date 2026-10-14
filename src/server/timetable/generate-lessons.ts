import { addDays, type IsoDate, isoWeekday, zonedTimeToUtc } from "./time";

export type SlotTemplate = {
  id: string;
  groupId: string;
  teacherId: string;
  roomId: string | null;
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
  startMinute: number;
  endMinute: number;
};

export type DateRange = { startDate: IsoDate; endDate: IsoDate };

export type LessonOccurrence = {
  timetableSlotId: string;
  groupId: string;
  teacherId: string;
  roomId: string | null;
  date: IsoDate;
  startsAt: Date;
  endsAt: Date;
};

export type GenerateLessonsInput = {
  slots: SlotTemplate[];
  /** Term dates, inclusive. */
  term: DateRange;
  /** Days without lessons, inclusive ranges. */
  holidays: DateRange[];
  /** IANA timezone the slot times are expressed in. */
  timeZone: string;
  /** Optional sub-range to generate (e.g. only the first weeks); clipped to the term. */
  range?: Partial<DateRange>;
};

function isHoliday(date: IsoDate, holidays: DateRange[]): boolean {
  return holidays.some((h) => h.startDate <= date && date <= h.endDate);
}

/**
 * Expands recurring timetable slots into concrete dated lesson occurrences for
 * every day of the term that is not a holiday. Pure: persisting is the
 * caller's job (lessons are unique per `[timetableSlotId, startsAt]`, so
 * re-running is idempotent).
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
      if (slot.weekday !== weekday) continue;
      occurrences.push({
        timetableSlotId: slot.id,
        groupId: slot.groupId,
        teacherId: slot.teacherId,
        roomId: slot.roomId,
        date,
        startsAt: zonedTimeToUtc(date, slot.startMinute, timeZone),
        endsAt: zonedTimeToUtc(date, slot.endMinute, timeZone),
      });
    }
  }
  return occurrences.sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
}
