// Absences, makeup credits and group replacements: pure rules
// (docs/architecture/replacements.md §2–§6). No Prisma, no Next.js,
// plain-data inputs, deterministic output. The database service
// (src/server/replacements) loads the data, calls these and writes in one
// transaction per action. The 1-on-1 reschedule rules are in reschedule.ts.

import { addDays, type IsoDate, toZonedDateTime, zonedTimeToUtc } from "./time";

const MINUTE_MS = 60_000;

/** Per-school settings (§2). */
export type AbsenceSettings = {
  /** A cancellation earns a credit only this long before the lesson. */
  absenceCutoffMinutes: number;
  /** A credit is valid this many days after the missed lesson's date. */
  makeupCreditValidDays: number;
};

/** Limits of the settings, as the database CHECKs enforce them (§2). */
export const ABSENCE_CUTOFF_MINUTES_MAX = 14 * 24 * 60;
export const MAKEUP_CREDIT_VALID_DAYS_MIN = 1;
export const MAKEUP_CREDIT_VALID_DAYS_MAX = 365;

/** `Lesson.cancelReason` of a 1-on-1 the student cancelled before the cutoff. */
export const STUDENT_CANCELLED = "STUDENT_CANCELLED";

/** `Lesson.cancelReason` of a 1-on-1 an admin moved to another time (§7). */
export const RESCHEDULED = "RESCHEDULED";

/** `Lesson.cancelReason` of a rescheduled 1-on-1 an admin cancelled (§7). */
export const SCHOOL_CANCELLED = "SCHOOL_CANCELLED";

/** Credits released by the school get at least this many more days (§4). */
export const RELEASE_GRACE_DAYS = 7;

/** The last instant a cancellation still earns a credit. */
export function cutoffAt(startsAt: Date, cutoffMinutes: number): Date {
  return new Date(startsAt.getTime() - cutoffMinutes * MINUTE_MS);
}

/**
 * Whether an absence reported at `reportedAt` earns a credit (§3):
 * `reportedAt ≤ startsAt − cutoff`. Exactly at the cutoff still counts.
 */
export function earnsCredit(
  startsAt: Date,
  reportedAt: Date,
  cutoffMinutes: number,
): boolean {
  return reportedAt.getTime() <= cutoffAt(startsAt, cutoffMinutes).getTime();
}

/**
 * Expiry of a credit for a lesson starting at `sourceStartsAt` (§4): valid
 * until the local date `sourceDate + validDays` (inclusive, what the UI
 * shows), so `expiresAt` is the start of the following local day in the
 * school's time zone. Anchored on the missed lesson, not the report time.
 */
export function creditExpiry(
  sourceStartsAt: Date,
  validDays: number,
  timeZone: string,
): { validUntil: IsoDate; expiresAt: Date } {
  const sourceDate = toZonedDateTime(sourceStartsAt, timeZone).date;
  const validUntil = addDays(sourceDate, validDays);
  return {
    validUntil,
    expiresAt: zonedTimeToUtc(addDays(validUntil, 1), 0, timeZone),
  };
}

/** The local date a credit is valid until, from its stored `expiresAt`. */
export function validUntilOf(expiresAt: Date, timeZone: string): IsoDate {
  return addDays(toZonedDateTime(expiresAt, timeZone).date, -1);
}

export type CreditStatus = "AVAILABLE" | "USED" | "EXPIRED";

/**
 * Effective state of a credit (§4): an AVAILABLE credit at or past its
 * expiry is EXPIRED, whatever the stored status says. Every read and every
 * write uses this, so correctness never depends on a background job.
 */
export function creditState(
  credit: { status: CreditStatus; expiresAt: Date },
  now: Date,
): CreditStatus {
  return credit.status === "AVAILABLE" &&
    now.getTime() >= credit.expiresAt.getTime()
    ? "EXPIRED"
    : credit.status;
}

/** Whole local days from `now` until a credit's last valid day (0 = today). */
export function daysLeft(expiresAt: Date, now: Date, timeZone: string): number {
  const today = toZonedDateTime(now, timeZone).date;
  const last = validUntilOf(expiresAt, timeZone);
  return Math.round(
    (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
      86_400_000,
  );
}

// ---------------------------------------------------------------------------
// Reporting an absence (§3)
// ---------------------------------------------------------------------------

/** Why an absence can't be reported; the order is the display order. */
export const ABSENCE_REASONS = [
  "NOT_PUBLISHED",
  "LESSON_CANCELLED",
  "LESSON_STARTED",
  "NOT_A_MEMBER",
  "REPLACEMENT_BOOKING",
  "ALREADY_REPORTED",
] as const;

export type AbsenceReason = (typeof ABSENCE_REASONS)[number];

export type AbsenceCheckInput = {
  lesson: {
    startsAt: Date;
    status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
    published: boolean;
  };
  /** The student is a member of the lesson's group at `startsAt`. */
  isMember: boolean;
  /** The student attends the lesson as an active replacement. */
  hasActiveReplacement: boolean;
  /** The student already has an absence report on the lesson. */
  alreadyReported: boolean;
};

/**
 * Every reason the student (or an admin for them) can't report an absence
 * on this lesson now; empty means allowed. A student attending as a
 * replacement cancels the booking instead (§6).
 */
export function checkAbsence(
  input: AbsenceCheckInput,
  now: Date,
): AbsenceReason[] {
  const reasons = new Set<AbsenceReason>();
  const { lesson } = input;
  if (!lesson.published) reasons.add("NOT_PUBLISHED");
  if (lesson.status !== "SCHEDULED") reasons.add("LESSON_CANCELLED");
  if (lesson.startsAt.getTime() <= now.getTime()) {
    reasons.add("LESSON_STARTED");
  }
  if (input.hasActiveReplacement) reasons.add("REPLACEMENT_BOOKING");
  else if (!input.isMember) reasons.add("NOT_A_MEMBER");
  if (input.alreadyReported) reasons.add("ALREADY_REPORTED");
  return ABSENCE_REASONS.filter((reason) => reasons.has(reason));
}

export type AbsencePlan = {
  earnsCredit: boolean;
  /** Set when a credit is earned. */
  credit: { validUntil: IsoDate; expiresAt: Date } | null;
  /**
   * A 1-on-1 cancelled before the cutoff is cancelled for everyone
   * (`STUDENT_CANCELLED`) so the teacher and room are free (§3). After the
   * cutoff it stays scheduled: the teacher keeps the time.
   */
  cancelLesson: boolean;
};

/** What reporting an absence on `lesson` at `now` does (§3 table). */
export function planAbsence(
  lesson: { startsAt: Date; type: "GROUP" | "ONE_ON_ONE" },
  settings: AbsenceSettings,
  timeZone: string,
  now: Date,
): AbsencePlan {
  const earns = earnsCredit(
    lesson.startsAt,
    now,
    settings.absenceCutoffMinutes,
  );
  return {
    earnsCredit: earns,
    credit: earns
      ? creditExpiry(lesson.startsAt, settings.makeupCreditValidDays, timeZone)
      : null,
    cancelLesson: earns && lesson.type === "ONE_ON_ONE",
  };
}

// ---------------------------------------------------------------------------
// Deleting an absence (§3, admin)
// ---------------------------------------------------------------------------

export type AbsenceDeleteRefusal = "ABSENCE_CREDIT_USED" | "LESSON_STARTED";

/**
 * Whether an admin may delete an absence: never while its credit is spent
 * (reject the booking first, which releases it), and a cancelled 1-on-1 can
 * only come back before it starts. The service checks timetable conflicts
 * for that restore separately.
 */
export function checkAbsenceDelete(input: {
  creditStatus: CreditStatus | null;
  restoresLesson: boolean;
  lessonStartsAt: Date;
  now: Date;
}): AbsenceDeleteRefusal | null {
  if (input.creditStatus === "USED") return "ABSENCE_CREDIT_USED";
  if (
    input.restoresLesson &&
    input.lessonStartsAt.getTime() <= input.now.getTime()
  ) {
    return "LESSON_STARTED";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Seats and the lesson's student list (§5, §9 "Teacher roster")
// ---------------------------------------------------------------------------

/** `members − absent + replacements` (§5). */
export function seatsTaken(input: {
  memberIds: readonly string[];
  absentIds: readonly string[];
  replacementIds: readonly string[];
}): number {
  const members = new Set(input.memberIds);
  const absent = input.absentIds.filter((id) => members.has(id));
  return members.size - new Set(absent).size + input.replacementIds.length;
}

export type RosterAbsence = {
  studentId: string;
  reportedAt: Date;
  reason: string | null;
  /** Reported by someone other than the student (an admin). */
  viaOffice: boolean;
  /** Earned a credit; a report without one was late. */
  hasCredit: boolean;
};

export type RosterStudent = { id: string; name: string };

export type Roster = {
  coming: (RosterStudent & { replacementFrom: string | null })[];
  notComing: (RosterStudent & {
    reportedAt: Date;
    reason: string | null;
    viaOffice: boolean;
    late: boolean;
    /** A replacement student who cancelled their booking late (§6). */
    replacement: boolean;
  })[];
  seatsTaken: number;
};

/**
 * Who is coming to a lesson and who isn't (§9): members at the lesson's
 * start minus those who cancelled, plus replacement students; not coming
 * are the absent members plus replacements cancelled after the cutoff
 * (`STUDENT_LATE`). Sorted by name.
 */
export function buildRoster(input: {
  members: readonly RosterStudent[];
  absences: readonly RosterAbsence[];
  replacements: readonly (RosterStudent & { fromGroup: string })[];
  lateCancelled?: readonly (RosterStudent & { cancelledAt: Date })[];
}): Roster {
  const absentBy = new Map(input.absences.map((a) => [a.studentId, a]));
  const byName = (
    a: { id: string; name: string },
    b: { id: string; name: string },
  ) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);
  const coming = [
    ...input.members
      .filter((m) => !absentBy.has(m.id))
      .map((m) => ({ ...m, replacementFrom: null })),
    ...input.replacements.map((r) => ({
      id: r.id,
      name: r.name,
      replacementFrom: r.fromGroup,
    })),
  ].sort(byName);
  const notComing = [
    ...input.members
      .filter((m) => absentBy.has(m.id))
      .map((m) => {
        const absence = absentBy.get(m.id)!;
        return {
          ...m,
          reportedAt: absence.reportedAt,
          reason: absence.reason,
          viaOffice: absence.viaOffice,
          late: !absence.hasCredit,
          replacement: false,
        };
      }),
    ...(input.lateCancelled ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      reportedAt: r.cancelledAt,
      reason: null,
      viaOffice: false,
      late: true,
      replacement: true,
    })),
  ].sort(byName);
  return {
    coming,
    notComing,
    seatsTaken: seatsTaken({
      memberIds: input.members.map((m) => m.id),
      absentIds: input.absences.map((a) => a.studentId),
      replacementIds: input.replacements.map((r) => r.id),
    }),
  };
}

// ---------------------------------------------------------------------------
// Releasing a used credit (§4)
// ---------------------------------------------------------------------------

/**
 * Why a spent credit comes back: the student cancelled their booking or
 * rescheduled 1-on-1 before its cutoff (same expiry), or the school took
 * it away — an admin rejected the booking or the lesson was cancelled
 * (at least `RELEASE_GRACE_DAYS` more days).
 */
export type ReleaseCause = "STUDENT" | "SCHOOL";

/**
 * The credit after a release (§4). With grace, `expiresAt` becomes the
 * later of the old one and the start of the local day after
 * `today + RELEASE_GRACE_DAYS`, so "valid until" shows a whole extra week
 * (never less than `now + 7 days`). A student's own release keeps the
 * expiry and is EXPIRED if that has passed.
 */
export function releaseCredit(
  credit: { expiresAt: Date },
  cause: ReleaseCause,
  timeZone: string,
  now: Date,
): { status: "AVAILABLE" | "EXPIRED"; expiresAt: Date } {
  if (cause === "STUDENT") {
    return {
      status:
        now.getTime() >= credit.expiresAt.getTime() ? "EXPIRED" : "AVAILABLE",
      expiresAt: credit.expiresAt,
    };
  }
  const today = toZonedDateTime(now, timeZone).date;
  const grace = zonedTimeToUtc(
    addDays(today, RELEASE_GRACE_DAYS + 1),
    0,
    timeZone,
  );
  return {
    status: "AVAILABLE",
    expiresAt:
      grace.getTime() > credit.expiresAt.getTime() ? grace : credit.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Group replacement eligibility (§6)
// ---------------------------------------------------------------------------

/** Why a lesson can't be booked as a replacement; the order is the display order. */
export const REPLACEMENT_REASONS = [
  "NOT_FOUND",
  "LESSON_NOT_PUBLISHED",
  "LESSON_CANCELLED",
  "LESSON_STARTED",
  "NOT_A_GROUP_LESSON",
  "SAME_LESSON",
  "ALREADY_ATTENDING",
  "CREDIT_UNAVAILABLE",
  "CREDIT_EXPIRES_FIRST",
  "NO_LEVEL",
  "LEVEL_MISMATCH",
  "ROOM_FULL",
  "STUDENT_CLASH",
] as const;

export type ReplacementReasonCode = (typeof REPLACEMENT_REASONS)[number];

/** Reasons an admin may override (acknowledging each); the rest block everyone. */
export const OVERRIDABLE_REPLACEMENT_REASONS: ReadonlySet<ReplacementReasonCode> =
  new Set([
    "CREDIT_EXPIRES_FIRST",
    "NO_LEVEL",
    "LEVEL_MISMATCH",
    "ROOM_FULL",
    "STUDENT_CLASH",
  ]);

/**
 * A failing reason with what its message needs. `key` is stable for the
 * same reason on the same data, so an admin's acknowledgement can be
 * checked again at save time (like timetable conflicts).
 */
export type ReplacementReason =
  | {
      code: "ROOM_FULL";
      key: string;
      params: { taken: number; capacity: number };
    }
  | { code: "LEVEL_MISMATCH"; key: string; params: { levelId: string } }
  | { code: "CREDIT_EXPIRES_FIRST"; key: string; params: { expiresAt: Date } }
  | { code: "STUDENT_CLASH"; key: string; params: { lessonIds: string[] } }
  | {
      code: Exclude<
        ReplacementReasonCode,
        | "ROOM_FULL"
        | "LEVEL_MISMATCH"
        | "CREDIT_EXPIRES_FIRST"
        | "STUDENT_CLASH"
      >;
      key: string;
      params: Record<string, never>;
    };

/** A lesson in time, for clash checks. */
export type TimedLesson = { id: string; startsAt: Date; endsAt: Date };

/**
 * A lesson the student attends (§6 "Lessons the student attends"): one of
 * their groups' non-cancelled lessons they haven't reported absent from,
 * or the target of one of their active bookings (`bookingId` set).
 */
export type AttendedLesson = TimedLesson & { bookingId?: string };

export type ReplacementCheckInput = {
  /** Null when the lesson isn't in the student's school (→ NOT_FOUND). */
  target: {
    id: string;
    startsAt: Date;
    endsAt: Date;
    status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
    published: boolean;
    groupType: "GROUP" | "ONE_ON_ONE";
    groupArchived: boolean;
    levelId: string;
    /** Null = no room, or a room without a capacity: no limit (§5). */
    capacity: number | null;
    /** `seatsTaken(target)` now, every active booking included. */
    seatsTaken: number;
  } | null;
  student: {
    id: string;
    levelId: string | null;
    /** Member of the target's group at its start. */
    isMemberOfTarget: boolean;
  };
  /** The student's active bookings. */
  bookings: readonly { id: string; targetLessonId: string }[];
  credit: {
    id: string;
    studentId: string;
    status: CreditStatus;
    expiresAt: Date;
    sourceLessonId: string;
    /** The missed lesson was a 1-on-1 (those credits only reschedule). */
    fromOneOnOne: boolean;
    /** The active booking this credit is spent on, if any. */
    bookingId: string | null;
  } | null;
  /** Lessons the student attends that may overlap the target. */
  attending: readonly AttendedLesson[];
};

const overlaps = (a: TimedLesson, b: TimedLesson) =>
  a.startsAt.getTime() < b.endsAt.getTime() &&
  b.startsAt.getTime() < a.endsAt.getTime();

/**
 * The student's lessons that overlap `target` (half-open intervals, so
 * back-to-back lessons don't clash), the target itself excluded, sorted by
 * start then id.
 */
export function studentClashes<T extends TimedLesson>(
  target: TimedLesson,
  attending: readonly T[],
): T[] {
  return attending
    .filter((lesson) => lesson.id !== target.id && overlaps(target, lesson))
    .sort(
      (a, b) =>
        a.startsAt.getTime() - b.startsAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

const reason = (
  code: ReplacementReason["code"],
  params: Record<string, unknown> = {},
  keySuffix = "",
): ReplacementReason =>
  ({
    code,
    key: keySuffix ? `${code}:${keySuffix}` : code,
    params,
  }) as ReplacementReason;

/**
 * Every reason `input.target` can't be booked with `input.credit` now
 * (§6), sorted in display order; empty means the booking is allowed.
 * With `review` set, the booking under review is left out of every input
 * (§6 _Admin review_): its own seat, credit and target don't count against
 * it, and LESSON_STARTED isn't evaluated.
 */
export function checkReplacement(
  input: ReplacementCheckInput,
  now: Date,
  review?: { bookingId: string },
): ReplacementReason[] {
  const { target, student, credit } = input;
  if (!target) return [reason("NOT_FOUND")];
  const out: ReplacementReason[] = [];
  const reviewId = review?.bookingId;
  const bookings = input.bookings.filter((b) => b.id !== reviewId);

  if (!target.published) out.push(reason("LESSON_NOT_PUBLISHED"));
  if (target.status !== "SCHEDULED") out.push(reason("LESSON_CANCELLED"));
  if (!review && target.startsAt.getTime() <= now.getTime()) {
    out.push(reason("LESSON_STARTED"));
  }
  if (target.groupType !== "GROUP" || target.groupArchived) {
    out.push(reason("NOT_A_GROUP_LESSON"));
  }
  if (credit && credit.sourceLessonId === target.id) {
    out.push(reason("SAME_LESSON"));
  }
  if (
    student.isMemberOfTarget ||
    bookings.some((b) => b.targetLessonId === target.id)
  ) {
    out.push(reason("ALREADY_ATTENDING"));
  }
  const creditOk =
    credit !== null &&
    credit.studentId === student.id &&
    !credit.fromOneOnOne &&
    (creditState(credit, now) === "AVAILABLE" ||
      (reviewId !== undefined &&
        credit.status === "USED" &&
        credit.bookingId === reviewId));
  if (!creditOk) out.push(reason("CREDIT_UNAVAILABLE"));
  if (credit && target.startsAt.getTime() >= credit.expiresAt.getTime()) {
    out.push(reason("CREDIT_EXPIRES_FIRST", { expiresAt: credit.expiresAt }));
  }
  if (student.levelId === null) out.push(reason("NO_LEVEL"));
  else if (student.levelId !== target.levelId) {
    out.push(
      reason("LEVEL_MISMATCH", { levelId: target.levelId }, target.levelId),
    );
  }
  if (target.capacity !== null) {
    // Under review the booking already holds one of the counted seats.
    const own =
      reviewId !== undefined &&
      input.bookings.some(
        (b) => b.id === reviewId && b.targetLessonId === target.id,
      )
        ? 1
        : 0;
    const taken = target.seatsTaken - own;
    if (taken + 1 > target.capacity) {
      out.push(
        reason(
          "ROOM_FULL",
          { taken: taken + 1, capacity: target.capacity },
          `${target.capacity}`,
        ),
      );
    }
  }
  const clashes = studentClashes(
    target,
    input.attending.filter(
      (l) => reviewId === undefined || l.bookingId !== reviewId,
    ),
  );
  if (clashes.length > 0) {
    const lessonIds = clashes.map((l) => l.id);
    out.push(reason("STUDENT_CLASH", { lessonIds }, lessonIds.join(",")));
  }
  const order = (code: ReplacementReasonCode) =>
    REPLACEMENT_REASONS.indexOf(code);
  return out.sort((a, b) => order(a.code) - order(b.code));
}

/**
 * `checkReplacement` for a booking under admin review (§6): the booking is
 * left out of every input. Also checks an Override's new target.
 */
export function reviewReplacement(
  input: ReplacementCheckInput,
  bookingId: string,
  now: Date,
): ReplacementReason[] {
  return checkReplacement(input, now, { bookingId });
}

export type ReplacementDecision =
  | { ok: true; overridden: ReplacementReason[] }
  | {
      ok: false;
      reason: "BLOCKED" | "UNACKNOWLEDGED";
      reasons: ReplacementReason[];
    };

/**
 * Whether an admin override may be saved: never with a blocking reason;
 * overridable ones only when each is acknowledged by key (the `decideSave`
 * pattern of the timetable editor).
 */
export function decideOverride(
  reasons: readonly ReplacementReason[],
  acknowledgedKeys: readonly string[],
): ReplacementDecision {
  if (reasons.some((r) => !OVERRIDABLE_REPLACEMENT_REASONS.has(r.code))) {
    return { ok: false, reason: "BLOCKED", reasons: [...reasons] };
  }
  const acknowledged = new Set(acknowledgedKeys);
  if (reasons.some((r) => !acknowledged.has(r.key))) {
    return { ok: false, reason: "UNACKNOWLEDGED", reasons: [...reasons] };
  }
  return { ok: true, overridden: [...reasons] };
}

// ---------------------------------------------------------------------------
// Cancelling a booking (§6, student)
// ---------------------------------------------------------------------------

export type BookingCancelPlan =
  | {
      ok: true;
      cancelReason: "STUDENT" | "STUDENT_LATE";
      releaseCredit: boolean;
    }
  | { ok: false; reason: "LESSON_STARTED" };

/**
 * A student cancelling their booking into a lesson starting at `startsAt`:
 * allowed until it starts; before the cutoff the credit comes back, after
 * it the credit stays spent (`STUDENT_LATE`).
 */
export function planBookingCancel(
  startsAt: Date,
  cutoffMinutes: number,
  now: Date,
): BookingCancelPlan {
  if (startsAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "LESSON_STARTED" };
  }
  const inTime = earnsCredit(startsAt, now, cutoffMinutes);
  return {
    ok: true,
    cancelReason: inTime ? "STUDENT" : "STUDENT_LATE",
    releaseCredit: inTime,
  };
}
