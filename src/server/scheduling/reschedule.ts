// 1-on-1 reschedule: pure rules (docs/architecture/replacements.md §7).
// A rescheduled 1-on-1 is a new ad-hoc lesson with the same teacher; where
// it may go is the timetable conflict checker (`checkLesson`) plus the
// credit, notice and student-clash rules below. No Prisma, no Next.js.

import { type Calendar, checkLesson } from "./conflicts";
import type { Conflict } from "./conflict-types";
import { compareStrings } from "./generate-lessons";
import {
  type AttendedLesson,
  type CreditStatus,
  creditState,
  studentClashes,
} from "./replacements";
import {
  addDays,
  type IsoDate,
  isoWeekday,
  toZonedDateTime,
  zonedTimeToUtc,
} from "./time";

const MINUTE_MS = 60_000;

/** Reschedule options start on this grid (minutes). */
export const RESCHEDULE_GRID_MINUTES = 15;

/** How many times the student is offered at most. */
export const RESCHEDULE_OPTIONS_LIMIT = 20;

/** Why a time can't be picked, besides timetable conflicts; display order. */
export const RESCHEDULE_REASONS = [
  "CREDIT_UNAVAILABLE",
  "TOO_SOON",
  "CREDIT_EXPIRES_FIRST",
  "OUTSIDE_TERM",
  "DURATION_CHANGED",
  "STUDENT_CLASH",
] as const;

export type RescheduleReasonCode = (typeof RESCHEDULE_REASONS)[number];

export type RescheduleReason = {
  code: RescheduleReasonCode;
  /** Stable fingerprint, for an admin's acknowledgement. */
  key: string;
  /** STUDENT_CLASH: the clashing lessons. */
  lessonIds?: string[];
};

export type RescheduleRequest = {
  /**
   * `student`: every rule applies and nothing can be overridden. `admin`
   * (§7 _Admin reschedule_): no notice limit, any duration, and
   * overridable conflicts can be acknowledged. A credit the admin spends
   * (not one already spent on the moving lesson) still checks its expiry,
   * as an acknowledgeable reason.
   */
  mode: "student" | "admin";
  /** The 1-on-1 group; the new lesson is an ad-hoc lesson of it. */
  groupId: string;
  /** The group's regular teacher of the missed lesson. */
  teacherId: string;
  /**
   * The scheduled lesson being moved (a rescheduled lesson moved again, or
   * the admin's source); it never conflicts with its own new time. Null
   * when the missed lesson is already cancelled.
   */
  movingLessonId: string | null;
  /** Its current start, never offered as a new time. */
  movingStartsAt?: Date | null;
  /** Length of the missed lesson, in minutes. */
  durationMinutes: number;
  /** The credit spent; null for an admin move without one. */
  credit: {
    studentId: string;
    status: CreditStatus;
    expiresAt: Date;
    /** Group of the credit's missed lesson. */
    sourceGroupId: string;
    /** Already spent on `movingLessonId` (moving it again, §3). */
    spentOnMoving: boolean;
  } | null;
  studentId: string;
  /** School-wide notice, the absence cutoff (§2). */
  cutoffMinutes: number;
  /** Terms the new lesson may fall in (published ones). */
  publishedTermIds: readonly string[];
  /** The student's other lessons (§6 definition), the moving one excluded. */
  attending: readonly AttendedLesson[];
};

export type RescheduleCandidate = {
  startsAt: Date;
  endsAt: Date;
  roomId: string | null;
};

export type RescheduleCheck = {
  reasons: RescheduleReason[];
  conflicts: Conflict[];
  /** The published term the new date falls in. */
  termId: string | null;
};

/** The published term containing the local `date`, if any. */
function termOn(
  calendar: Calendar,
  publishedTermIds: readonly string[],
  date: IsoDate,
): string | null {
  const ids = [...publishedTermIds].sort(compareStrings);
  for (const id of ids) {
    const term = calendar.terms.get(id);
    if (term && term.startDate <= date && date <= term.endDate) return id;
  }
  return null;
}

/**
 * Everything wrong with moving the 1-on-1 to `candidate` (§7): the reasons
 * in display order, and the timetable checker's conflicts for the new
 * ad-hoc lesson. A student may only pick a time with neither.
 */
export function checkReschedule(
  calendar: Calendar,
  request: RescheduleRequest,
  candidate: RescheduleCandidate,
  now: Date,
): RescheduleCheck {
  const reasons: RescheduleReason[] = [];
  const add = (code: RescheduleReasonCode, extra?: Partial<RescheduleReason>) =>
    reasons.push({ code, key: code, ...extra });
  const student = request.mode === "student";
  const { credit } = request;

  if (credit) {
    const usable =
      credit.studentId === request.studentId &&
      credit.sourceGroupId === request.groupId &&
      (creditState(credit, now) === "AVAILABLE" ||
        (credit.spentOnMoving && credit.status === "USED"));
    if (!usable) add("CREDIT_UNAVAILABLE");
  } else if (student) {
    add("CREDIT_UNAVAILABLE");
  }
  if (
    student &&
    candidate.startsAt.getTime() <
      now.getTime() + request.cutoffMinutes * MINUTE_MS
  ) {
    add("TOO_SOON");
  }
  if (
    credit &&
    (student || !credit.spentOnMoving) &&
    candidate.startsAt.getTime() >= credit.expiresAt.getTime()
  ) {
    add("CREDIT_EXPIRES_FIRST");
  }
  const { timeZone } = calendar.context.school;
  const date = toZonedDateTime(candidate.startsAt, timeZone).date;
  const termId = termOn(calendar, request.publishedTermIds, date);
  if (!termId) add("OUTSIDE_TERM");
  const minutes =
    (candidate.endsAt.getTime() - candidate.startsAt.getTime()) / MINUTE_MS;
  if (student && minutes !== request.durationMinutes) add("DURATION_CHANGED");
  // Admins can't move a lesson into the past either.
  if (!student && candidate.startsAt.getTime() <= now.getTime()) {
    add("TOO_SOON");
  }

  const clashes = studentClashes(
    { id: request.movingLessonId ?? "", ...candidate },
    request.attending.filter((l) => l.id !== request.movingLessonId),
  );
  if (clashes.length > 0) {
    const lessonIds = clashes.map((l) => l.id);
    add("STUDENT_CLASH", {
      key: `STUDENT_CLASH:${lessonIds.join(",")}`,
      lessonIds,
    });
  }

  const conflicts = termId
    ? checkLesson(calendar, {
        // The moving lesson is "self": its old time never blocks the new one.
        ...(request.movingLessonId && { id: request.movingLessonId }),
        termId,
        timetableSlotId: null,
        occurrenceDate: null,
        groupId: request.groupId,
        teacherId: request.teacherId,
        substituteTeacherId: null,
        roomId: candidate.roomId,
        startsAt: candidate.startsAt,
        endsAt: candidate.endsAt,
      })
    : [];

  const order = (code: RescheduleReasonCode) =>
    RESCHEDULE_REASONS.indexOf(code);
  return {
    reasons: reasons.sort((a, b) => order(a.code) - order(b.code)),
    conflicts,
    termId,
  };
}

/** A student may take a time only when nothing at all is wrong with it. */
export const isFreeTime = (check: RescheduleCheck) =>
  check.reasons.length === 0 && check.conflicts.length === 0;

export type AdminRescheduleDecision =
  | {
      ok: true;
      overriddenConflicts: Conflict[];
      overriddenReasons: RescheduleReason[];
    }
  | {
      ok: false;
      reason: "BLOCKING" | "UNACKNOWLEDGED";
      blockingReasons: RescheduleReason[];
      unacknowledged: string[];
    };

/**
 * Reasons an admin can acknowledge; the rest (unusable credit, term, past)
 * block. CREDIT_EXPIRES_FIRST only fires for admins spending a credit.
 */
export const ADMIN_OVERRIDABLE: ReadonlySet<RescheduleReasonCode> = new Set([
  "CREDIT_EXPIRES_FIRST",
  "STUDENT_CLASH",
]);

/**
 * Whether an admin reschedule may be saved (§7): blocking conflicts,
 * OUTSIDE_TERM, a past time or an unusable credit refuse; overridable
 * conflicts, CREDIT_EXPIRES_FIRST and STUDENT_CLASH need each key
 * acknowledged.
 */
export function decideAdminReschedule(
  check: RescheduleCheck,
  acknowledgedKeys: readonly string[],
): AdminRescheduleDecision {
  const blockingReasons = check.reasons.filter(
    (r) => !ADMIN_OVERRIDABLE.has(r.code),
  );
  const blockingConflicts = check.conflicts.filter(
    (c) => c.severity === "blocking",
  );
  const acknowledged = new Set(acknowledgedKeys);
  const overridableConflicts = check.conflicts.filter(
    (c) => c.severity === "overridable",
  );
  const overridableReasons = check.reasons.filter((r) =>
    ADMIN_OVERRIDABLE.has(r.code),
  );
  const unacknowledged = [
    ...overridableConflicts.map((c) => c.key),
    ...overridableReasons.map((r) => r.key),
  ].filter((key) => !acknowledged.has(key));
  if (blockingReasons.length > 0 || blockingConflicts.length > 0) {
    return { ok: false, reason: "BLOCKING", blockingReasons, unacknowledged };
  }
  if (unacknowledged.length > 0) {
    return {
      ok: false,
      reason: "UNACKNOWLEDGED",
      blockingReasons,
      unacknowledged,
    };
  }
  return {
    ok: true,
    overriddenConflicts: overridableConflicts,
    overriddenReasons: overridableReasons,
  };
}

export type RescheduleOption = RescheduleCandidate & {
  /** Same weekday and start time as the missed lesson ("usual time"). */
  usual: boolean;
};

/**
 * Up to `limit` free times for a student's reschedule (§7): starts on a
 * 15-minute grid on teaching days inside school hours, from `now + cutoff`
 * until the credit expires, each with a room that yields no conflict
 * (`roomPreference` in order: the missed lesson's room, the slot's, then
 * other rooms of the same kind by name; `[null]` when it had no room).
 * Ordered: the missed lesson's weekday and time first, then nearest date,
 * then earliest time. Deterministic for the same input.
 */
export function rescheduleOptions(
  calendar: Calendar,
  request: RescheduleRequest,
  usual: { weekday: number; startMinute: number },
  roomPreference: readonly (string | null)[],
  now: Date,
  limit = RESCHEDULE_OPTIONS_LIMIT,
): RescheduleOption[] {
  const { credit } = request;
  if (!credit || roomPreference.length === 0) return [];
  const school = calendar.context.school;
  const { timeZone } = school;
  const earliest = new Date(now.getTime() + request.cutoffMinutes * MINUTE_MS);
  const firstDate = toZonedDateTime(earliest, timeZone).date;
  const lastDate = toZonedDateTime(
    new Date(credit.expiresAt.getTime() - 1),
    timeZone,
  ).date;
  const duration = request.durationMinutes * MINUTE_MS;

  const dates: IsoDate[] = [];
  for (let d = firstDate; d <= lastDate; d = addDays(d, 1)) {
    if (school.teachingWeekdays.includes(isoWeekday(d))) dates.push(d);
  }

  const tryAt = (date: IsoDate, minute: number): RescheduleOption | null => {
    const startsAt = zonedTimeToUtc(date, minute, timeZone);
    // A local time that doesn't exist (DST gap) maps elsewhere: skip it.
    const local = toZonedDateTime(startsAt, timeZone);
    if (local.date !== date || local.minute !== minute) return null;
    const endsAt = new Date(startsAt.getTime() + duration);
    if (startsAt < earliest || startsAt >= credit.expiresAt) return null;
    if (startsAt.getTime() === request.movingStartsAt?.getTime()) return null;
    // Problems without a room stay with any room: check those once.
    const bare = checkReschedule(
      calendar,
      request,
      { startsAt, endsAt, roomId: null },
      now,
    );
    if (!isFreeTime(bare)) return null;
    for (const roomId of roomPreference) {
      if (roomId === null) {
        return { startsAt, endsAt, roomId, usual: false };
      }
      const check = checkReschedule(
        calendar,
        request,
        { startsAt, endsAt, roomId },
        now,
      );
      if (isFreeTime(check)) return { startsAt, endsAt, roomId, usual: false };
    }
    return null;
  };

  const out: RescheduleOption[] = [];
  const tried = new Set<string>();
  const lastStart = school.dayEndMinute - request.durationMinutes;
  // Usual time first, nearest date first.
  if (
    usual.startMinute >= school.dayStartMinute &&
    usual.startMinute <= lastStart
  ) {
    for (const date of dates) {
      if (out.length >= limit) return out;
      if (isoWeekday(date) !== usual.weekday) continue;
      const option = tryAt(date, usual.startMinute);
      tried.add(`${date}|${usual.startMinute}`);
      if (option) out.push({ ...option, usual: true });
    }
  }
  for (const date of dates) {
    for (
      let minute = school.dayStartMinute;
      minute <= lastStart;
      minute += RESCHEDULE_GRID_MINUTES
    ) {
      if (out.length >= limit) return out;
      if (tried.has(`${date}|${minute}`)) continue;
      const option = tryAt(date, minute);
      if (option) out.push(option);
    }
  }
  return out;
}
