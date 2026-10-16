// Ratings: the pure rules (docs/architecture/phase5-rules.md §4). Who may
// rate whom and when, which lessons count as attended, and the admin
// summary of a teacher's ratings. Plain data in, deterministic output, no
// Prisma, no Next.js, no `Date.now()`: the service passes `now`.

import {
  addDays,
  daysBetween,
  type IsoDate,
  zonedTimeToUtc,
} from "@/server/scheduling";
import { isMemberAt, type MembershipWindow } from "@/server/timetable/week";

/** Attended lessons with a teacher in a term needed to rate them (§4.1). */
export const RATING_MIN_LESSONS = 3;
/** Rating stays open this many days after the term ends (§4.1). */
export const RATING_GRACE_DAYS = 14;
/** Fewer visible ratings than this show no average (§4.3). */
export const RATING_MIN_FOR_AVERAGE = 3;
export const RATING_COMMENT_MAX = 1000;
export const RATING_SCORES = [1, 2, 3, 4, 5] as const;

export type RatingTerm = { id: string; startDate: IsoDate; endDate: IsoDate };

/**
 * Start of the local day at half-term: `startDate + ⌊(endDate − startDate)
 * / 2⌋` days, in the school's time zone.
 */
export function ratingOpensAt(term: RatingTerm, timeZone: string): Date {
  const half = Math.floor(daysBetween(term.startDate, term.endDate) / 2);
  return zonedTimeToUtc(addDays(term.startDate, half), 0, timeZone);
}

/** Start of the local day `RATING_GRACE_DAYS` after the term's last day. */
export function ratingClosesAt(term: RatingTerm, timeZone: string): Date {
  return zonedTimeToUtc(addDays(term.endDate, RATING_GRACE_DAYS), 0, timeZone);
}

export function ratingWindow(term: RatingTerm, timeZone: string) {
  return {
    opensAt: ratingOpensAt(term, timeZone),
    closesAt: ratingClosesAt(term, timeZone),
  };
}

/** What the rules need to know about one lesson. */
export type RatingLesson = {
  id: string;
  termId: string;
  groupId: string;
  teacherId: string;
  substituteTeacherId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
};

/** One student's attendance facts (`attendeesOf`, applied to one student). */
export type StudentAttendance = {
  memberships: readonly MembershipWindow[];
  /** Lessons the student reported an absence from. */
  absentLessonIds: ReadonlySet<string>;
  /** Target lessons of the student's active replacement bookings. */
  replacementLessonIds: ReadonlySet<string>;
};

export const effectiveTeacherId = (lesson: RatingLesson): string =>
  lesson.substituteTeacherId ?? lesson.teacherId;

/**
 * Lessons the student attended (§4.1; there is no attendance record): the
 * lesson has **ended**, isn't cancelled, and the student was an attendee —
 * a member of the group when it started with no absence report on it, or
 * held an active replacement into it. Sorted by start, then id.
 */
export function attendedLessons<L extends RatingLesson>(
  student: StudentAttendance,
  lessons: readonly L[],
  now: Date,
): L[] {
  return lessons
    .filter(
      (lesson) =>
        lesson.endsAt.getTime() <= now.getTime() &&
        lesson.status !== "CANCELLED" &&
        (student.replacementLessonIds.has(lesson.id) ||
          (isMemberAt(student.memberships, lesson.groupId, lesson.startsAt) &&
            !student.absentLessonIds.has(lesson.id))),
    )
    .sort(
      (a, b) =>
        a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id),
    );
}

/** Attended lessons per term and effective teacher: `termId → teacherId → lessons`. */
export function attendedByTermAndTeacher<L extends RatingLesson>(
  student: StudentAttendance,
  lessons: readonly L[],
  now: Date,
): Map<string, Map<string, L[]>> {
  const out = new Map<string, Map<string, L[]>>();
  for (const lesson of attendedLessons(student, lessons, now)) {
    const byTeacher = out.get(lesson.termId) ?? new Map<string, L[]>();
    out.set(lesson.termId, byTeacher);
    const teacherId = effectiveTeacherId(lesson);
    byTeacher.set(teacherId, [...(byTeacher.get(teacherId) ?? []), lesson]);
  }
  return out;
}

export const CAN_RATE_REASONS = [
  "NOT_A_STUDENT",
  "TEACHER_UNKNOWN",
  "TOO_FEW_LESSONS",
  "NOT_OPEN_YET",
  "WINDOW_CLOSED",
] as const;

export type CanRateReason = (typeof CAN_RATE_REASONS)[number];

export type CanRateInput = {
  /** A `STUDENT` membership in the school, user not deleted. */
  isStudent: boolean;
  /** A teacher of the same school, not archived. */
  teacherKnown: boolean;
  /** Attended lessons of the term whose effective teacher was the teacher. */
  attended: number;
  term: RatingTerm;
  timeZone: string;
  now: Date;
};

export type CanRateResult = {
  ok: boolean;
  /** Every failing rule, in `CAN_RATE_REASONS` order. */
  reasons: CanRateReason[];
  opensAt: Date;
  closesAt: Date;
};

/** Whether a student may rate a teacher for a term now (§4.1). */
export function canRate(input: CanRateInput): CanRateResult {
  const { opensAt, closesAt } = ratingWindow(input.term, input.timeZone);
  const now = input.now.getTime();
  const reasons: CanRateReason[] = [];
  if (!input.isStudent) reasons.push("NOT_A_STUDENT");
  if (!input.teacherKnown) reasons.push("TEACHER_UNKNOWN");
  if (input.attended < RATING_MIN_LESSONS) reasons.push("TOO_FEW_LESSONS");
  if (now < opensAt.getTime()) reasons.push("NOT_OPEN_YET");
  if (now >= closesAt.getTime()) reasons.push("WINDOW_CLOSED");
  return { ok: reasons.length === 0, reasons, opensAt, closesAt };
}

/**
 * How a teacher appears on the student's _Rate your teachers_ list (§4.1):
 * `open` (may rate, hasn't), `rated` (may change it), `opensLater` (only
 * `NOT_OPEN_YET` fails), `closed` (rated, window over: read-only). Null
 * when the teacher isn't listed.
 */
export type RatingCardState = "open" | "rated" | "opensLater" | "closed";

export function ratingCardState(
  result: CanRateResult,
  hasRating: boolean,
): RatingCardState | null {
  if (result.ok) return hasRating ? "rated" : "open";
  if (hasRating) return "closed";
  if (result.reasons.length === 1 && result.reasons[0] === "NOT_OPEN_YET") {
    return "opensLater";
  }
  return null;
}

export type RatingScoreRow = {
  score: number;
  hiddenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RatingSummary = {
  /** Visible (not hidden) ratings. */
  count: number;
  /** One decimal; null below `RATING_MIN_FOR_AVERAGE` visible ratings. */
  average: number | null;
  /** Visible ratings per score, index 0 = 1 star … 4 = 5 stars. */
  distribution: [number, number, number, number, number];
  /** Latest write of a visible rating. */
  lastRatedAt: Date | null;
  hidden: number;
};

/** The admin summary of one teacher's ratings in a term (§4.3). */
export function summarizeRatings(
  rows: readonly RatingScoreRow[],
): RatingSummary {
  const visible = rows.filter((r) => r.hiddenAt === null);
  const distribution: RatingSummary["distribution"] = [0, 0, 0, 0, 0];
  let sum = 0;
  let last: number | null = null;
  for (const row of visible) {
    distribution[row.score - 1] += 1;
    sum += row.score;
    const at = row.updatedAt.getTime();
    if (last === null || at > last) last = at;
  }
  return {
    count: visible.length,
    average:
      visible.length >= RATING_MIN_FOR_AVERAGE
        ? Math.round((sum / visible.length) * 10) / 10
        : null,
    distribution,
    lastRatedAt: last === null ? null : new Date(last),
    hidden: rows.length - visible.length,
  };
}

/** Trimmed comment, null when empty (§4.2). */
export function normalizeComment(comment: string | null | undefined) {
  const trimmed = (comment ?? "").trim();
  return trimmed === "" ? null : trimmed;
}
