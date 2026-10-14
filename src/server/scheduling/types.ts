// Plain-data inputs of the scheduling module. They mirror the Prisma models
// (see prisma/schema.prisma) but carry only what scheduling needs, with
// calendar days as "YYYY-MM-DD" strings. The module never imports Prisma or
// Next.js: the service in src/server/timetable/ loads these from the database.

import type { DateRange, SlotTemplate } from "./generate-lessons";
import type { IsoDate } from "./time";

export type { DateRange, IsoDate, SlotTemplate };

/** When a school teaches. Times are minutes since midnight in `timeZone`. */
export type SchoolCalendar = {
  /** IANA time zone, `School.timezone`. */
  timeZone: string;
  /** ISO weekdays (1 = Monday … 7 = Sunday) lessons are normally held on. */
  teachingWeekdays: readonly number[];
  /** Earliest lesson start, e.g. 420 = 07:00. */
  dayStartMinute: number;
  /** Latest lesson end, e.g. 1260 = 21:00. */
  dayEndMinute: number;
};

export type TermInfo = DateRange & { id: string; name: string };

/** `termId` null = school-wide holiday, applies to every term. */
export type HolidayInfo = DateRange & {
  id: string;
  name: string;
  termId: string | null;
};

/** A stored or proposed weekly slot. `validFrom`/`validUntil` null = term bounds. */
export type SlotInfo = SlotTemplate & {
  termId: string;
  validFrom: IsoDate | null;
  validUntil: IsoDate | null;
};

export type LessonStatus = "SCHEDULED" | "CANCELLED" | "COMPLETED";

export type LessonInfo = {
  id: string;
  termId: string;
  /** Null for ad-hoc lessons. */
  timetableSlotId: string | null;
  /** Set for generated lessons. */
  occurrenceDate: IsoDate | null;
  groupId: string;
  /** Regular teacher; the one teaching is `substituteTeacherId ?? teacherId`. */
  teacherId: string;
  substituteTeacherId: string | null;
  roomId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: LessonStatus;
};

export type GroupInfo = {
  id: string;
  name: string;
  type: "GROUP" | "ONE_ON_ONE";
  capacity: number;
  /** Students currently enrolled (`GroupMembership.leftAt` null). */
  studentIds: readonly string[];
  /** Archived groups (`Group.deletedAt`) cannot get new slots or lessons. */
  archived: boolean;
};

export type RoomInfo = {
  id: string;
  name: string;
  kind: "PHYSICAL" | "ONLINE";
  /** Null for online rooms without a limit. */
  capacity: number | null;
  /**
   * Archived rooms (`Room.archivedAt`) cannot get new slots or lessons;
   * slots and lessons already in them keep running and are still checked.
   */
  archived: boolean;
};

export type PersonInfo = { id: string; name: string };

export type AvailabilityRule = {
  id: string;
  teacherId: string;
  kind: "WEEKLY_UNAVAILABLE" | "DATE_UNAVAILABLE" | "DATE_AVAILABLE";
  /** WEEKLY_UNAVAILABLE only. */
  weekday: number | null;
  /** DATE_* kinds only. */
  date: IsoDate | null;
  /** Both null = whole day (DATE_* kinds only). */
  startMinute: number | null;
  endMinute: number | null;
};

/**
 * Everything the checker compares a candidate against. Load the candidate's
 * term plus every term overlapping it, with their slots, lessons and
 * holidays, so clashes across overlapping terms are found too.
 */
export type SchedulingContext = {
  school: SchoolCalendar;
  terms: readonly TermInfo[];
  holidays: readonly HolidayInfo[];
  slots: readonly SlotInfo[];
  lessons: readonly LessonInfo[];
  groups: readonly GroupInfo[];
  rooms: readonly RoomInfo[];
  teachers: readonly PersonInfo[];
  students: readonly PersonInfo[];
  availability: readonly AvailabilityRule[];
};

/** A slot to validate. `id` set = edit of that slot (it is not compared with itself). */
export type SlotCandidate = Omit<SlotInfo, "id"> & { id?: string };

/** A single dated lesson to validate (moved, substituted or ad-hoc). */
export type LessonCandidate = Omit<LessonInfo, "id" | "status"> & {
  id?: string;
};
