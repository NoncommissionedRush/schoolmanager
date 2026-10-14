// Group replacements: booking, cancelling and admin review (CARM-43,
// docs/architecture/replacements.md §5, §6, §8). Loads plain data through
// the school-scoped client, asks the pure rules (checkReplacement,
// reviewReplacement, planBookingCancel) and writes in one transaction per
// action that first takes the school's timetable lock, re-loads and
// re-checks everything. One clock: callers pass `now` once per request.

import type { Prisma } from "@/generated/prisma/client";
import { pageWindow } from "@/server/admin/list";
import { AdminError, msg } from "@/server/admin/result";
import { isUniqueViolation } from "@/server/admin/shared";
import { isUuid } from "@/server/lessons/access";
import {
  type AttendedLesson,
  checkReplacement,
  creditState,
  decideOverride,
  planBookingCancel,
  type ReplacementCheckInput,
  type ReplacementReason,
  reviewReplacement,
  seatsTaken,
  toZonedDateTime,
  validUntilOf,
} from "@/server/scheduling";
import {
  lockTimetable,
  type SchoolDb,
  type Tx,
} from "@/server/timetable/service";
import { isMemberAt, membersAt } from "@/server/timetable/week";

import { ACTIVE_REPLACEMENT, releaseSpentCredit } from "./release";

const notFound = () => new AdminError(msg("common.error.notFound"));
const refusal = (code: string) =>
  new AdminError(msg(`replacements.errors.${code}`));

/** The school's settings every action here needs. */
async function schoolOf(tx: Tx | SchoolDb) {
  return tx.school.findFirstOrThrow({
    select: { id: true, timezone: true, absenceCutoffMinutes: true },
  });
}

async function inLockedTransaction<T>(
  db: SchoolDb,
  fn: (tx: Tx, school: Awaited<ReturnType<typeof schoolOf>>) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const school = await schoolOf(tx);
    await lockTimetable(tx, school.id);
    return fn(tx, school);
  });
}

// ---------------------------------------------------------------------------
// Loading the rule inputs
// ---------------------------------------------------------------------------

const targetSelect = {
  id: true,
  groupId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  term: { select: { timetablePublishedAt: true } },
  group: {
    select: {
      name: true,
      type: true,
      deletedAt: true,
      levelId: true,
      level: { select: { code: true } },
    },
  },
  room: { select: { name: true, kind: true, capacity: true } },
  teacher: { select: { user: { select: { name: true } } } },
  substituteTeacher: { select: { user: { select: { name: true } } } },
} satisfies Prisma.LessonSelect;

type TargetRow = Prisma.LessonGetPayload<{ select: typeof targetSelect }>;

/** `seatsTaken` of many lessons at once (§5). */
async function seatsOfLessons(
  tx: Tx | SchoolDb,
  lessons: readonly { id: string; groupId: string; startsAt: Date }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (lessons.length === 0) return out;
  const lessonIds = lessons.map((l) => l.id);
  const [memberships, absences, bookings] = await Promise.all([
    tx.groupMembership.findMany({
      where: { groupId: { in: [...new Set(lessons.map((l) => l.groupId))] } },
      select: { groupId: true, studentId: true, joinedAt: true, leftAt: true },
    }),
    tx.absenceReport.findMany({
      where: { lessonId: { in: lessonIds } },
      select: { lessonId: true, studentId: true },
    }),
    tx.replacementRequest.findMany({
      where: {
        targetLessonId: { in: lessonIds },
        status: { in: [...ACTIVE_REPLACEMENT] },
      },
      select: { targetLessonId: true, studentId: true },
    }),
  ]);
  for (const lesson of lessons) {
    out.set(
      lesson.id,
      seatsTaken({
        memberIds: membersAt(
          memberships.filter((m) => m.groupId === lesson.groupId),
          lesson.startsAt,
        ).map((m) => m.studentId),
        absentIds: absences
          .filter((a) => a.lessonId === lesson.id)
          .map((a) => a.studentId),
        replacementIds: bookings
          .filter((b) => b.targetLessonId === lesson.id)
          .map((b) => b.studentId),
      }),
    );
  }
  return out;
}

type StudentInfo = {
  id: string;
  userId: string;
  name: string;
  levelId: string | null;
  memberships: { groupId: string; joinedAt: Date; leftAt: Date | null }[];
};

const studentSelect = {
  id: true,
  userId: true,
  levelId: true,
  user: { select: { name: true } },
  groupMemberships: {
    select: { groupId: true, joinedAt: true, leftAt: true },
  },
} satisfies Prisma.StudentProfileSelect;

function toStudentInfo(
  row: Prisma.StudentProfileGetPayload<{ select: typeof studentSelect }>,
): StudentInfo {
  return {
    id: row.id,
    userId: row.userId,
    name: row.user.name,
    levelId: row.levelId,
    memberships: row.groupMemberships,
  };
}

/**
 * The lessons a student attends between `from` and `to` (§6): their
 * groups' lessons while a member, not cancelled and not reported absent,
 * plus the targets of their active bookings.
 */
export async function loadAttending(
  tx: Tx | SchoolDb,
  student: Pick<StudentInfo, "id" | "memberships">,
  from: Date,
  to: Date,
): Promise<AttendedLesson[]> {
  const groupIds = [...new Set(student.memberships.map((m) => m.groupId))];
  const [lessons, absences, bookings] = await Promise.all([
    tx.lesson.findMany({
      where: {
        groupId: { in: groupIds },
        status: { not: "CANCELLED" },
        startsAt: { lt: to },
        endsAt: { gt: from },
      },
      select: { id: true, groupId: true, startsAt: true, endsAt: true },
    }),
    tx.absenceReport.findMany({
      where: { studentId: student.id },
      select: { lessonId: true },
    }),
    tx.replacementRequest.findMany({
      where: {
        studentId: student.id,
        status: { in: [...ACTIVE_REPLACEMENT] },
        targetLesson: {
          status: { not: "CANCELLED" },
          startsAt: { lt: to },
          endsAt: { gt: from },
        },
      },
      select: {
        id: true,
        targetLesson: { select: { id: true, startsAt: true, endsAt: true } },
      },
    }),
  ]);
  const absent = new Set(absences.map((a) => a.lessonId));
  return [
    ...lessons
      .filter(
        (l) =>
          !absent.has(l.id) &&
          isMemberAt(student.memberships, l.groupId, l.startsAt),
      )
      .map(({ id, startsAt, endsAt }) => ({ id, startsAt, endsAt })),
    ...bookings.map((b) => ({ ...b.targetLesson, bookingId: b.id })),
  ];
}

const creditSelect = {
  id: true,
  studentId: true,
  status: true,
  expiresAt: true,
  sourceLessonId: true,
  sourceLesson: {
    select: {
      startsAt: true,
      group: { select: { name: true, type: true } },
    },
  },
  replacements: {
    where: { status: { in: [...ACTIVE_REPLACEMENT] } },
    select: { id: true },
  },
} satisfies Prisma.MakeupCreditSelect;

type CreditRow = Prisma.MakeupCreditGetPayload<{ select: typeof creditSelect }>;

function creditInput(credit: CreditRow): ReplacementCheckInput["credit"] {
  return {
    id: credit.id,
    studentId: credit.studentId,
    status: credit.status,
    expiresAt: credit.expiresAt,
    sourceLessonId: credit.sourceLessonId,
    fromOneOnOne: credit.sourceLesson.group.type === "ONE_ON_ONE",
    bookingId: credit.replacements[0]?.id ?? null,
  };
}

function targetInput(
  row: TargetRow,
  seats: number,
): NonNullable<ReplacementCheckInput["target"]> {
  return {
    id: row.id,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status,
    published: row.term.timetablePublishedAt !== null,
    groupType: row.group.type,
    groupArchived: row.group.deletedAt !== null,
    levelId: row.group.levelId,
    capacity: row.room?.capacity ?? null,
    seatsTaken: seats,
  };
}

/** Everything `checkReplacement` needs about one student, for many targets. */
async function studentContext(
  tx: Tx | SchoolDb,
  student: StudentInfo,
  window: { from: Date; to: Date },
) {
  const [bookings, attending] = await Promise.all([
    tx.replacementRequest.findMany({
      where: { studentId: student.id, status: { in: [...ACTIVE_REPLACEMENT] } },
      select: { id: true, targetLessonId: true },
    }),
    loadAttending(tx, student, window.from, window.to),
  ]);
  return {
    input: (
      target: TargetRow,
      seats: number,
      credit: ReplacementCheckInput["credit"],
    ): ReplacementCheckInput => ({
      target: targetInput(target, seats),
      student: {
        id: student.id,
        levelId: student.levelId,
        isMemberOfTarget: isMemberAt(
          student.memberships,
          target.groupId,
          target.startsAt,
        ),
      },
      bookings,
      credit,
      attending,
    }),
  };
}

// ---------------------------------------------------------------------------
// Messages for reasons
// ---------------------------------------------------------------------------

/**
 * A reason as the UI shows it (`replacements.reasons.<code>`), with names
 * and local times filled in. Student DTOs only ever carry their own
 * lessons here.
 */
export type ReasonView = {
  code: ReplacementReason["code"];
  key: string;
  overridable: boolean;
  /** ROOM_FULL */
  taken?: number;
  capacity?: number;
  /** LEVEL_MISMATCH: the target's level code. */
  level?: string;
  /** STUDENT_CLASH: the first clashing lesson. */
  clash?: { group: string; date: string; startMinute: number };
  /** CREDIT_EXPIRES_FIRST: the credit's last valid day. */
  validUntil?: string;
};

async function reasonViews(
  tx: Tx | SchoolDb,
  reasons: readonly ReplacementReason[],
  timeZone: string,
): Promise<ReasonView[]> {
  const out: ReasonView[] = [];
  for (const r of reasons) {
    const base = {
      code: r.code,
      key: r.key,
      overridable: [
        "CREDIT_EXPIRES_FIRST",
        "NO_LEVEL",
        "LEVEL_MISMATCH",
        "ROOM_FULL",
        "STUDENT_CLASH",
      ].includes(r.code),
    };
    if (r.code === "ROOM_FULL") {
      out.push({ ...base, ...r.params });
    } else if (r.code === "LEVEL_MISMATCH") {
      const level = await tx.level.findFirst({
        where: { id: r.params.levelId },
        select: { code: true },
      });
      out.push({ ...base, level: level?.code ?? "" });
    } else if (r.code === "STUDENT_CLASH") {
      const lesson = await tx.lesson.findFirst({
        where: { id: r.params.lessonIds[0] },
        select: { startsAt: true, group: { select: { name: true } } },
      });
      const local = lesson && toZonedDateTime(lesson.startsAt, timeZone);
      out.push({
        ...base,
        clash: lesson
          ? {
              group: lesson.group.name,
              date: local!.date,
              startMinute: local!.minute,
            }
          : undefined,
      });
    } else if (r.code === "CREDIT_EXPIRES_FIRST") {
      out.push({
        ...base,
        validUntil: validUntilOf(r.params.expiresAt, timeZone),
      });
    } else {
      out.push(base);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Student: book a replacement (§6, absences.md §5.5)
// ---------------------------------------------------------------------------

export type BookResult =
  | { status: "booked"; bookingId: string; startsAt: string }
  /** Lost a race or the lesson changed: the fresh reasons (§8). */
  | { status: "refused"; reasons: ReasonView[] };

/**
 * The signed-in student books `targetLessonId` with their credit
 * `creditId`: re-checks every rule under the lock, spends the credit with
 * a conditional update and creates an AUTO_APPROVED booking. Credits and
 * lessons that aren't theirs to see are "not found".
 */
export async function bookReplacement(
  db: SchoolDb,
  actor: { userId: string },
  input: { creditId: string; targetLessonId: string },
  now: Date,
): Promise<BookResult> {
  if (!isUuid(input.creditId) || !isUuid(input.targetLessonId)) {
    throw notFound();
  }
  return inLockedTransaction(db, async (tx, school) => {
    const studentRow = await tx.studentProfile.findFirst({
      where: { userId: actor.userId },
      select: studentSelect,
    });
    if (!studentRow) throw notFound();
    const student = toStudentInfo(studentRow);
    const credit = await tx.makeupCredit.findFirst({
      where: { id: input.creditId, studentId: student.id },
      select: creditSelect,
    });
    if (!credit) throw notFound();
    const target = await tx.lesson.findFirst({
      where: { id: input.targetLessonId },
      select: targetSelect,
    });
    // Unpublished lessons don't exist for students.
    if (!target || target.term.timetablePublishedAt === null) throw notFound();

    const seats = await seatsOfLessons(tx, [target]);
    const context = await studentContext(tx, student, {
      from: target.startsAt,
      to: target.endsAt,
    });
    const reasons = checkReplacement(
      context.input(target, seats.get(target.id) ?? 0, creditInput(credit)),
      now,
    );
    if (reasons.length > 0) {
      return {
        status: "refused",
        reasons: await reasonViews(tx, reasons, school.timezone),
      };
    }

    // Conditional: a credit spent or expired meanwhile is never spent twice.
    const { count } = await tx.makeupCredit.updateMany({
      where: { id: credit.id, status: "AVAILABLE", expiresAt: { gt: now } },
      data: { status: "USED", usedAt: now },
    });
    if (count !== 1) throw refusal("CREDIT_UNAVAILABLE");
    let bookingId: string;
    try {
      const row = await tx.replacementRequest.create({
        data: {
          schoolId: school.id,
          studentId: student.id,
          originalLessonId: credit.sourceLessonId,
          targetLessonId: target.id,
          makeupCreditId: credit.id,
          status: "AUTO_APPROVED",
          createdAt: now,
        },
        select: { id: true },
      });
      bookingId = row.id;
    } catch (error) {
      if (isUniqueViolation(error)) throw refusal("ALREADY_ATTENDING");
      throw error;
    }
    await tx.auditLog.create({
      data: {
        schoolId: school.id,
        actorId: actor.userId,
        action: "replacement.booked",
        entityType: "ReplacementRequest",
        entityId: bookingId,
        data: {
          studentId: student.id,
          creditId: credit.id,
          originalLessonId: credit.sourceLessonId,
          targetLessonId: target.id,
          seatsTaken: (seats.get(target.id) ?? 0) + 1,
          capacity: target.room?.capacity ?? null,
        },
      },
    });
    return {
      status: "booked",
      bookingId,
      startsAt: target.startsAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Student: cancel a booking (§6, absences.md §5.7)
// ---------------------------------------------------------------------------

export type CancelBookingResult = {
  /** The credit is AVAILABLE again. */
  creditBack: boolean;
  /** Released, but its expiry had passed. */
  creditExpired: boolean;
  validUntil: string;
};

/**
 * The signed-in student cancels one of their active bookings, until the
 * target starts. Before the cutoff the credit comes back with its own
 * expiry (`STUDENT`); after it, it stays spent (`STUDENT_LATE`).
 */
export async function cancelBooking(
  db: SchoolDb,
  actor: { userId: string },
  bookingId: string,
  now: Date,
): Promise<CancelBookingResult> {
  if (!isUuid(bookingId)) throw notFound();
  return inLockedTransaction(db, async (tx, school) => {
    const booking = await tx.replacementRequest.findFirst({
      where: {
        id: bookingId,
        student: { userId: actor.userId },
        status: { in: [...ACTIVE_REPLACEMENT] },
      },
      select: {
        id: true,
        status: true,
        studentId: true,
        targetLesson: { select: { id: true, startsAt: true } },
        makeupCredit: { select: { id: true, expiresAt: true } },
      },
    });
    if (!booking) throw notFound();
    const plan = planBookingCancel(
      booking.targetLesson.startsAt,
      school.absenceCutoffMinutes,
      now,
    );
    if (!plan.ok) throw refusal(plan.reason);
    const { count } = await tx.replacementRequest.updateMany({
      where: { id: booking.id, status: booking.status },
      data: {
        status: "CANCELLED",
        cancelledAt: now,
        cancelReason: plan.cancelReason,
      },
    });
    if (count !== 1) throw notFound();
    let credit = {
      status: "USED" as string,
      expiresAt: booking.makeupCredit.expiresAt,
    };
    if (plan.releaseCredit) {
      credit = await releaseSpentCredit(
        tx,
        booking.makeupCredit,
        "STUDENT",
        school.timezone,
        now,
      );
    }
    await tx.auditLog.create({
      data: {
        schoolId: school.id,
        actorId: actor.userId,
        action: "replacement.cancelled",
        entityType: "ReplacementRequest",
        entityId: booking.id,
        data: {
          reason: plan.cancelReason,
          previousStatus: booking.status,
          targetLessonId: booking.targetLesson.id,
          studentId: booking.studentId,
          creditId: booking.makeupCredit.id,
          creditStatus: credit.status,
        },
      },
    });
    return {
      creditBack: credit.status === "AVAILABLE",
      creditExpired: credit.status === "EXPIRED",
      validUntil: validUntilOf(credit.expiresAt, school.timezone),
    };
  });
}

// ---------------------------------------------------------------------------
// Student: the "Book a replacement" list (absences.md §5.5)
// ---------------------------------------------------------------------------

/** One bookable lesson, as the student sees it: no other students' names. */
export type EligibleLesson = {
  id: string;
  date: string;
  startMinute: number;
  endMinute: number;
  startsAt: string;
  groupName: string;
  roomName: string | null;
  online: boolean;
  teacherName: string;
  /** Null when the room has no capacity (no limit, no count shown). */
  seatsLeft: number | null;
  /** Last instant cancelling the booking gives the credit back. */
  cutoffAt: string;
};

export type BookingPage =
  | {
      state: "ok";
      credit: { id: string; sourceDate: string; validUntil: string };
      /** Other available group credits, to switch (§5.5 header). */
      otherCredits: { id: string; sourceDate: string; validUntil: string }[];
      level: string;
      lessons: EligibleLesson[];
    }
  | { state: "noLevel" }
  | { state: "expired"; validUntil: string }
  | { state: "used" }
  | { state: "notFound" };

/**
 * The lessons the student can book with credit `creditId` now: every
 * candidate at their level, not started, before the credit's expiry, for
 * which `checkReplacement` returns no reasons, ordered by start.
 */
export async function loadBookingPage(
  db: SchoolDb,
  student: { userId: string },
  creditId: string,
  now: Date,
): Promise<BookingPage> {
  if (!isUuid(creditId)) return { state: "notFound" };
  const school = await schoolOf(db);
  const tz = school.timezone;
  const studentRow = await db.studentProfile.findFirst({
    where: { userId: student.userId },
    select: { ...studentSelect, level: { select: { code: true } } },
  });
  if (!studentRow) return { state: "notFound" };
  const info = toStudentInfo(studentRow);
  const credits = await db.makeupCredit.findMany({
    where: { studentId: info.id },
    select: creditSelect,
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
  });
  const credit = credits.find((c) => c.id === creditId);
  if (!credit || credit.sourceLesson.group.type !== "GROUP") {
    return { state: "notFound" };
  }
  const state = creditState(credit, now);
  if (state === "EXPIRED") {
    return { state: "expired", validUntil: validUntilOf(credit.expiresAt, tz) };
  }
  if (state === "USED") return { state: "used" };
  if (!studentRow.levelId || !studentRow.level) return { state: "noLevel" };

  const describe = (c: CreditRow) => ({
    id: c.id,
    sourceDate: toZonedDateTime(c.sourceLesson.startsAt, tz).date,
    validUntil: validUntilOf(c.expiresAt, tz),
  });
  const candidates = await db.lesson.findMany({
    where: {
      status: "SCHEDULED",
      startsAt: { gt: now, lt: credit.expiresAt },
      term: { timetablePublishedAt: { not: null } },
      group: { type: "GROUP", levelId: studentRow.levelId, deletedAt: null },
    },
    select: targetSelect,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
  const seats = await seatsOfLessons(db, candidates);
  const context = await studentContext(db, info, {
    from: now,
    to: credit.expiresAt,
  });
  const lessons: EligibleLesson[] = [];
  for (const target of candidates) {
    const taken = seats.get(target.id) ?? 0;
    const reasons = checkReplacement(
      context.input(target, taken, creditInput(credit)),
      now,
    );
    if (reasons.length > 0) continue;
    const start = toZonedDateTime(target.startsAt, tz);
    const end = toZonedDateTime(target.endsAt, tz);
    const capacity = target.room?.capacity ?? null;
    lessons.push({
      id: target.id,
      date: start.date,
      startMinute: start.minute,
      endMinute: end.date === start.date ? end.minute : 24 * 60,
      startsAt: target.startsAt.toISOString(),
      groupName: target.group.name,
      roomName: target.room?.name ?? null,
      online: target.room?.kind === "ONLINE",
      teacherName: (target.substituteTeacher ?? target.teacher).user.name,
      seatsLeft: capacity === null ? null : capacity - taken,
      cutoffAt: new Date(
        target.startsAt.getTime() - school.absenceCutoffMinutes * 60_000,
      ).toISOString(),
    });
  }
  return {
    state: "ok",
    credit: describe(credit),
    otherCredits: credits
      .filter(
        (c) =>
          c.id !== credit.id &&
          c.sourceLesson.group.type === "GROUP" &&
          creditState(c, now) === "AVAILABLE",
      )
      .map(describe),
    level: studentRow.level.code,
    lessons,
  };
}

// ---------------------------------------------------------------------------
// Admin review (§6 _Admin review_, absences.md §7.3)
// ---------------------------------------------------------------------------

const bookingSelect = {
  id: true,
  status: true,
  studentId: true,
  targetLessonId: true,
  makeupCreditId: true,
  student: { select: studentSelect },
  targetLesson: { select: targetSelect },
  makeupCredit: { select: creditSelect },
} satisfies Prisma.ReplacementRequestSelect;

type BookingRow = Prisma.ReplacementRequestGetPayload<{
  select: typeof bookingSelect;
}>;

/** `reviewReplacement` of `booking` against `target` (its own, or a new one). */
async function reviewBooking(
  tx: Tx | SchoolDb,
  booking: BookingRow,
  target: TargetRow,
  now: Date,
): Promise<ReplacementReason[]> {
  const seats = await seatsOfLessons(tx, [target]);
  const context = await studentContext(tx, toStudentInfo(booking.student), {
    from: target.startsAt,
    to: target.endsAt,
  });
  return reviewReplacement(
    context.input(
      target,
      seats.get(target.id) ?? 0,
      creditInput(booking.makeupCredit),
    ),
    booking.id,
    now,
  );
}

export type ReviewResult =
  | { status: "done" }
  /** The booking changed while the dialog was open (absences.md §7.3). */
  | { status: "changed" }
  /** Override: reasons that block or still need acknowledging. */
  | { status: "reasons"; blocked: boolean; reasons: ReasonView[] };

type ReviewActor = { userId: string };

async function loadForReview(
  tx: Tx,
  bookingId: string,
  expectedStatus: string | undefined,
  now: Date,
): Promise<BookingRow | "changed"> {
  const booking = await tx.replacementRequest.findFirst({
    where: { id: bookingId },
    select: bookingSelect,
  });
  if (!booking) throw notFound();
  if (
    (expectedStatus !== undefined && booking.status !== expectedStatus) ||
    !(ACTIVE_REPLACEMENT as readonly string[]).includes(booking.status)
  ) {
    return "changed";
  }
  // Reviews of started lessons are read-only (§6).
  if (booking.targetLesson.startsAt.getTime() <= now.getTime()) {
    throw refusal("LESSON_STARTED");
  }
  return booking;
}

async function auditReview(
  tx: Tx,
  schoolId: string,
  actor: ReviewActor,
  action: "approved" | "rejected" | "overridden",
  booking: BookingRow,
  data: Record<string, unknown>,
) {
  await tx.auditLog.create({
    data: {
      schoolId,
      actorId: actor.userId,
      action: `replacement.${action}`,
      entityType: "ReplacementRequest",
      entityId: booking.id,
      data: JSON.parse(
        JSON.stringify({
          previousStatus: booking.status,
          studentId: booking.studentId,
          previousTargetLessonId: booking.targetLessonId,
          ...data,
        }),
      ),
    },
  });
}

/**
 * Approves AUTO_APPROVED bookings whose lesson hasn't started and that have
 * no failing reason now (those need Override). Returns how many changed;
 * any booking that changed meanwhile or has issues refuses the whole batch.
 */
export async function approveReplacements(
  db: SchoolDb,
  actor: ReviewActor,
  bookingIds: readonly string[],
  now: Date,
): Promise<ReviewResult & { count?: number }> {
  if (bookingIds.length === 0 || !bookingIds.every(isUuid)) throw notFound();
  return inLockedTransaction(db, async (tx, school) => {
    // Check every booking before writing any: a booking reviewed, cancelled
    // or with new issues meanwhile is "changed" for the whole batch
    // (absences.md §7.3); the row then offers Override.
    const checked: BookingRow[] = [];
    for (const id of new Set(bookingIds)) {
      const booking = await loadForReview(tx, id, "AUTO_APPROVED", now);
      if (booking === "changed") return { status: "changed" };
      const reasons = await reviewBooking(
        tx,
        booking,
        booking.targetLesson,
        now,
      );
      if (reasons.length > 0) return { status: "changed" };
      checked.push(booking);
    }
    for (const booking of checked) {
      await tx.replacementRequest.update({
        where: { id: booking.id },
        data: {
          status: "APPROVED",
          reviewedById: actor.userId,
          reviewedAt: now,
          reviewNote: null,
        },
      });
      await auditReview(tx, school.id, actor, "approved", booking, {
        targetLessonId: booking.targetLessonId,
      });
    }
    return { status: "done", count: checked.length };
  });
}

/**
 * Rejects an active booking before its lesson starts: REJECTED, the
 * student no longer attends, and the credit comes back with grace (§4).
 */
export async function rejectReplacement(
  db: SchoolDb,
  actor: ReviewActor,
  input: { bookingId: string; note: string; expectedStatus?: string },
  now: Date,
): Promise<ReviewResult & { validUntil?: string }> {
  if (!isUuid(input.bookingId)) throw notFound();
  return inLockedTransaction(db, async (tx, school) => {
    const booking = await loadForReview(
      tx,
      input.bookingId,
      input.expectedStatus,
      now,
    );
    if (booking === "changed") return { status: "changed" };
    await tx.replacementRequest.update({
      where: { id: booking.id },
      data: {
        status: "REJECTED",
        reviewedById: actor.userId,
        reviewedAt: now,
        reviewNote: input.note,
      },
    });
    const credit = await releaseSpentCredit(
      tx,
      booking.makeupCredit,
      "SCHOOL",
      school.timezone,
      now,
    );
    await auditReview(tx, school.id, actor, "rejected", booking, {
      note: input.note,
      creditId: booking.makeupCredit.id,
      creditExpiresAt: credit.expiresAt.toISOString(),
    });
    return {
      status: "done",
      validUntil: validUntilOf(credit.expiresAt, school.timezone),
    };
  });
}

/**
 * Overrides an active booking: keeps it, or moves it to `targetLessonId`,
 * despite overridable reasons, each acknowledged by key. Blocking reasons
 * refuse. Status OVERRIDDEN, the credit stays spent.
 */
export async function overrideReplacement(
  db: SchoolDb,
  actor: ReviewActor,
  input: {
    bookingId: string;
    /** Null keeps the current lesson. */
    targetLessonId: string | null;
    acknowledgedKeys: readonly string[];
    note: string;
    expectedStatus?: string;
  },
  now: Date,
): Promise<ReviewResult & { startsAt?: string }> {
  if (
    !isUuid(input.bookingId) ||
    (input.targetLessonId !== null && !isUuid(input.targetLessonId))
  ) {
    throw notFound();
  }
  return inLockedTransaction(db, async (tx, school) => {
    const booking = await loadForReview(
      tx,
      input.bookingId,
      input.expectedStatus,
      now,
    );
    if (booking === "changed") return { status: "changed" };
    let target = booking.targetLesson;
    if (input.targetLessonId && input.targetLessonId !== target.id) {
      const row = await tx.lesson.findFirst({
        where: { id: input.targetLessonId },
        select: targetSelect,
      });
      if (!row) throw notFound();
      target = row;
    }
    // Moving into a lesson that has started is never allowed.
    const reasons = await reviewBooking(tx, booking, target, now);
    if (target.startsAt.getTime() <= now.getTime()) {
      throw refusal("LESSON_STARTED");
    }
    const decision = decideOverride(reasons, input.acknowledgedKeys);
    if (!decision.ok) {
      return {
        status: "reasons",
        blocked: decision.reason === "BLOCKED",
        reasons: await reasonViews(tx, reasons, school.timezone),
      };
    }
    try {
      await tx.replacementRequest.update({
        where: { id: booking.id },
        data: {
          targetLessonId: target.id,
          status: "OVERRIDDEN",
          reviewedById: actor.userId,
          reviewedAt: now,
          reviewNote: input.note,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw refusal("ALREADY_ATTENDING");
      throw error;
    }
    await auditReview(tx, school.id, actor, "overridden", booking, {
      targetLessonId: target.id,
      note: input.note,
      acknowledged: decision.overridden.map((r) => ({
        code: r.code,
        key: r.key,
        params: r.params,
      })),
    });
    return { status: "done", startsAt: target.startsAt.toISOString() };
  });
}

// ---------------------------------------------------------------------------
// Admin lists: Review and Replacements tabs (absences.md §7.2)
// ---------------------------------------------------------------------------

type LessonRef = {
  id: string;
  date: string;
  startMinute: number;
  endMinute: number;
  groupName: string;
};

export type AdminBookingRow = {
  id: string;
  status:
    "AUTO_APPROVED" | "APPROVED" | "REJECTED" | "OVERRIDDEN" | "CANCELLED";
  cancelReason: string | null;
  bookedAt: string;
  student: { id: string; name: string };
  from: LessonRef;
  to: LessonRef & { started: boolean };
  room: { name: string; capacity: number | null } | null;
  seatsTaken: number;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** Live `reviewReplacement` reasons; only for active, upcoming bookings. */
  issues: ReasonView[];
};

const adminRowSelect = {
  ...bookingSelect,
  cancelReason: true,
  createdAt: true,
  reviewedAt: true,
  reviewNote: true,
  reviewedBy: { select: { name: true } },
  originalLesson: {
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      group: { select: { name: true } },
    },
  },
} satisfies Prisma.ReplacementRequestSelect;

function lessonRef(
  lesson: {
    id: string;
    startsAt: Date;
    endsAt: Date;
    group: { name: string };
  },
  timeZone: string,
): LessonRef {
  const start = toZonedDateTime(lesson.startsAt, timeZone);
  const end = toZonedDateTime(lesson.endsAt, timeZone);
  return {
    id: lesson.id,
    date: start.date,
    startMinute: start.minute,
    endMinute: end.date === start.date ? end.minute : 24 * 60,
    groupName: lesson.group.name,
  };
}

async function toAdminRows(
  db: SchoolDb,
  rows: Prisma.ReplacementRequestGetPayload<{
    select: typeof adminRowSelect;
  }>[],
  timeZone: string,
  now: Date,
): Promise<AdminBookingRow[]> {
  const seats = await seatsOfLessons(
    db,
    rows.map((r) => r.targetLesson),
  );
  const out: AdminBookingRow[] = [];
  for (const row of rows) {
    const started = row.targetLesson.startsAt.getTime() <= now.getTime();
    const active = (ACTIVE_REPLACEMENT as readonly string[]).includes(
      row.status,
    );
    const issues =
      active && !started
        ? await reasonViews(
            db,
            await reviewBooking(db, row, row.targetLesson, now),
            timeZone,
          )
        : [];
    out.push({
      id: row.id,
      status: row.status,
      cancelReason: row.cancelReason,
      bookedAt: row.createdAt.toISOString(),
      student: { id: row.student.id, name: row.student.user.name },
      from: lessonRef(row.originalLesson, timeZone),
      to: { ...lessonRef(row.targetLesson, timeZone), started },
      room: row.targetLesson.room && {
        name: row.targetLesson.room.name,
        capacity: row.targetLesson.room.capacity,
      },
      seatsTaken: seats.get(row.targetLesson.id) ?? 0,
      reviewedBy: row.reviewedBy?.name ?? null,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewNote: row.reviewNote,
      issues,
    });
  }
  return out;
}

/**
 * The Review tab: AUTO_APPROVED bookings whose lesson hasn't started,
 * rows with issues first, then by lesson start (most urgent on top).
 */
export async function listReviewQueue(
  db: SchoolDb,
  now: Date,
): Promise<AdminBookingRow[]> {
  const school = await schoolOf(db);
  const rows = await db.replacementRequest.findMany({
    where: { status: "AUTO_APPROVED", targetLesson: { startsAt: { gt: now } } },
    select: adminRowSelect,
    orderBy: [{ targetLesson: { startsAt: "asc" } }, { id: "asc" }],
  });
  const list = await toAdminRows(db, rows, school.timezone, now);
  return list.sort(
    (a, b) => Number(b.issues.length > 0) - Number(a.issues.length > 0),
  );
}

/** Count for the Review tab label and the admin dashboard. */
export async function countReviewQueue(db: SchoolDb, now: Date) {
  return db.replacementRequest.count({
    where: { status: "AUTO_APPROVED", targetLesson: { startsAt: { gt: now } } },
  });
}

const BOOKING_STATUSES: readonly AdminBookingRow["status"][] = [
  "AUTO_APPROVED",
  "APPROVED",
  "REJECTED",
  "OVERRIDDEN",
  "CANCELLED",
];

export type AdminReplacementFilters = {
  from: Date;
  until: Date;
  studentId?: string;
  groupId?: string;
  teacherId?: string;
  status?: string;
};

/** The Replacements tab: every booking with a target in the period. */
export async function listAdminReplacements(
  db: SchoolDb,
  filters: AdminReplacementFilters,
  page: number,
  now: Date,
): Promise<{
  total: number;
  window: ReturnType<typeof pageWindow>;
  rows: AdminBookingRow[];
}> {
  const school = await schoolOf(db);
  const where: Prisma.ReplacementRequestWhereInput = {
    ...(filters.studentId && { studentId: filters.studentId }),
    ...(filters.status &&
      BOOKING_STATUSES.includes(
        filters.status as AdminBookingRow["status"],
      ) && { status: filters.status as AdminBookingRow["status"] }),
    targetLesson: {
      startsAt: { gte: filters.from, lt: filters.until },
      ...(filters.groupId && { groupId: filters.groupId }),
      ...(filters.teacherId && {
        OR: [
          { teacherId: filters.teacherId },
          { substituteTeacherId: filters.teacherId },
        ],
      }),
    },
  };
  const total = await db.replacementRequest.count({ where });
  const window = pageWindow(page, total);
  const rows = await db.replacementRequest.findMany({
    where,
    select: adminRowSelect,
    orderBy: [{ targetLesson: { startsAt: "asc" } }, { id: "asc" }],
    skip: window.skip,
    take: window.take,
  });
  return {
    total,
    window,
    rows: await toAdminRows(db, rows, school.timezone, now),
  };
}

export type OverrideOption = LessonRef & {
  startsAt: string;
  roomName: string | null;
  teacherName: string;
  reasons: ReasonView[];
};

/**
 * Lessons the Override dialog offers for a booking (absences.md §7.3):
 * upcoming group lessons up to 30 days ahead with no blocking reason —
 * only reason-free ones, or with `showAll` also those with overridable
 * reasons — each with its reasons. The current target is left out (it is
 * the "Keep" option).
 */
export async function listOverrideOptions(
  db: SchoolDb,
  bookingId: string,
  showAll: boolean,
  now: Date,
): Promise<{ current: OverrideOption; options: OverrideOption[] } | null> {
  if (!isUuid(bookingId)) return null;
  const school = await schoolOf(db);
  const tz = school.timezone;
  const booking = await db.replacementRequest.findFirst({
    where: { id: bookingId },
    select: bookingSelect,
  });
  if (!booking) return null;
  const until = new Date(now.getTime() + 30 * 86_400_000);
  const candidates = await db.lesson.findMany({
    where: {
      id: { not: booking.targetLessonId },
      status: "SCHEDULED",
      startsAt: { gt: now, lt: until },
      term: { timetablePublishedAt: { not: null } },
      group: {
        type: "GROUP",
        deletedAt: null,
        ...(!showAll &&
          booking.student.levelId && { levelId: booking.student.levelId }),
      },
    },
    select: targetSelect,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
  const all = [booking.targetLesson, ...candidates];
  const seats = await seatsOfLessons(db, all);
  const context = await studentContext(db, toStudentInfo(booking.student), {
    from: now,
    to:
      until.getTime() > booking.targetLesson.endsAt.getTime()
        ? until
        : booking.targetLesson.endsAt,
  });
  const credit = creditInput(booking.makeupCredit);
  const describe = async (target: TargetRow) => {
    const reasons = reviewReplacement(
      context.input(target, seats.get(target.id) ?? 0, credit),
      booking.id,
      now,
    );
    return {
      option: {
        ...lessonRef(target, tz),
        startsAt: target.startsAt.toISOString(),
        roomName: target.room?.name ?? null,
        teacherName: (target.substituteTeacher ?? target.teacher).user.name,
        reasons: await reasonViews(db, reasons, tz),
      },
      reasons,
    };
  };
  const current = (await describe(booking.targetLesson)).option;
  const options: OverrideOption[] = [];
  for (const target of candidates) {
    const { option, reasons } = await describe(target);
    const blocked = option.reasons.some((r) => !r.overridable);
    if (blocked || (!showAll && reasons.length > 0)) continue;
    options.push(option);
  }
  return { current, options };
}
