// Absences and makeup credits: pure rules (docs/architecture/replacements.md
// §2–§4). No Prisma, no Next.js, plain-data inputs, deterministic output.
// The database service (src/server/replacements) loads the data, calls these
// and writes in one transaction per action. Replacement booking and 1-on-1
// reschedule rules join this module in CARM-43.

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
  })[];
  seatsTaken: number;
};

/**
 * Who is coming to a lesson and who isn't (§9): members at the lesson's
 * start minus those who cancelled, plus replacement students; sorted by
 * name.
 */
export function buildRoster(input: {
  members: readonly RosterStudent[];
  absences: readonly RosterAbsence[];
  replacements: readonly (RosterStudent & { fromGroup: string })[];
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
  const notComing = input.members
    .filter((m) => absentBy.has(m.id))
    .map((m) => {
      const absence = absentBy.get(m.id)!;
      return {
        ...m,
        reportedAt: absence.reportedAt,
        reason: absence.reason,
        viaOffice: absence.viaOffice,
        late: !absence.hasCredit,
      };
    })
    .sort(byName);
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
