// Absences and makeup credits: the database service (CARM-42,
// docs/architecture/replacements.md §3, §4, §8). It loads plain data through
// the school-scoped client, asks the pure rules in
// src/server/scheduling/replacements.ts, and writes in one transaction per
// action that first takes the school's timetable lock. One clock: callers
// pass `now` once per request and every rule and SQL condition uses it.

import type { Role } from "@/generated/prisma/enums";
import { AdminError, msg } from "@/server/admin/result";
import { isUniqueViolation } from "@/server/admin/shared";
import { isUuid } from "@/server/lessons/access";
import {
  checkAbsence,
  checkAbsenceDelete,
  type Conflict,
  creditExpiry,
  creditState,
  decideSave,
  planAbsence,
  seatsTaken,
  STUDENT_CANCELLED,
  toZonedDateTime,
  validUntilOf,
} from "@/server/scheduling";
import {
  checkLessonInTransaction,
  lockTimetable,
  type SchoolDb,
  type Tx,
} from "@/server/timetable/service";
import { isMemberAt, membersAt } from "@/server/timetable/week";

import { ACTIVE_REPLACEMENT, releaseSpentCredit } from "./release";

export { ACTIVE_REPLACEMENT };

/** Who is acting: the student themselves, or an admin of their school. */
export type AbsenceActor = { userId: string; role: Role };

export type ReportAbsenceInput = {
  lessonId: string;
  /** Admins name the student; a student always reports for themselves. */
  studentId?: string;
  reason: string | null;
  /**
   * The dialog promised a credit. If the cutoff passed meanwhile, nothing
   * is written and the caller asks again (absences.md §5.2).
   */
  expectCredit?: boolean;
};

export type ReportAbsenceResult =
  | {
      status: "reported";
      absenceId: string;
      studentName: string;
      credit: { id: string; validUntil: string } | null;
      lessonCancelled: boolean;
    }
  | { status: "cutoffPassed" };

const notFound = () => new AdminError(msg("common.error.notFound"));

/** Refusals students and admins see, by rule reason. */
const refusal = (code: string) =>
  new AdminError(msg(`absences.errors.${code}`));

/**
 * Runs `fn` in one transaction that first takes the school's timetable
 * lock (§8), with the school's settings.
 */
export async function inLockedTransaction<T>(
  db: SchoolDb,
  fn: (tx: Tx, school: SchoolSettings) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const school: SchoolSettings = await tx.school.findFirstOrThrow({
      select: {
        id: true,
        timezone: true,
        absenceCutoffMinutes: true,
        makeupCreditValidDays: true,
      },
    });
    await lockTimetable(tx, school.id);
    return fn(tx, school);
  });
}

/**
 * Reports an absence (§3): the student for themselves, or an admin of the
 * school for a student. Teachers (and anyone else) are refused. Before the
 * cutoff it creates the report and an AVAILABLE credit; a 1-on-1 is then
 * cancelled for everyone. After the cutoff only the report. Lessons the
 * student may not see are "not found".
 */
export async function reportAbsence(
  db: SchoolDb,
  actor: AbsenceActor,
  input: ReportAbsenceInput,
  now: Date,
): Promise<ReportAbsenceResult> {
  assertReportInput(actor, input);
  return inLockedTransaction(db, async (tx, school) => {
    const result = await reportAbsenceInTx(tx, school, actor, input, now);
    if (result.status === "cutoffPassed") return result;
    return {
      status: "reported",
      absenceId: result.absenceId,
      studentName: result.studentName,
      credit: result.credit,
      lessonCancelled: result.lessonCancelled,
    };
  });
}

/** Who may report and with which ids (shared with the reschedule flow). */
export function assertReportInput(
  actor: AbsenceActor,
  input: { lessonId: string; studentId?: string },
) {
  if (actor.role !== "STUDENT" && actor.role !== "ADMIN") {
    throw new AdminError(msg("absences.errors.FORBIDDEN"));
  }
  // Malformed ids can't match a record (CARM-32).
  if (
    !isUuid(input.lessonId) ||
    (input.studentId !== undefined && !isUuid(input.studentId)) ||
    (actor.role === "ADMIN" && input.studentId === undefined)
  ) {
    throw notFound();
  }
}

export type SchoolSettings = {
  id: string;
  timezone: string;
  absenceCutoffMinutes: number;
  makeupCreditValidDays: number;
};

/**
 * The first lesson of a reschedule chain: follow `rescheduledFromId` back
 * to the regular lesson an admin (or the student) moved first (§3).
 */
export async function chainRoot(
  tx: Tx,
  lesson: { id: string; startsAt: Date; rescheduledFromId: string | null },
): Promise<{ id: string; startsAt: Date }> {
  let current = lesson;
  // Chains are short; the bound only guards against a corrupt cycle.
  for (let i = 0; i < 1_000 && current.rescheduledFromId; i++) {
    const previous = await tx.lesson.findFirst({
      where: { id: current.rescheduledFromId },
      select: { id: true, startsAt: true, rescheduledFromId: true },
    });
    if (!previous) break;
    current = previous;
  }
  return current;
}

/**
 * `reportAbsence` inside the caller's locked transaction. Besides §3's
 * table, a 1-on-1 that is itself a reschedule never mints a credit when a
 * credit is spent on it: in time, the lesson is cancelled and that credit
 * comes back with its own expiry; late, it stays spent. An admin-moved
 * 1-on-1 without a credit earns one in time, valid from the chain root.
 */
export async function reportAbsenceInTx(
  tx: Tx,
  school: SchoolSettings,
  actor: AbsenceActor,
  input: ReportAbsenceInput,
  now: Date,
): Promise<
  | (Extract<ReportAbsenceResult, { status: "reported" }> & {
      lesson: {
        id: string;
        groupId: string;
        teacherId: string;
        roomId: string | null;
        timetableSlotId: string | null;
        startsAt: Date;
        endsAt: Date;
        rescheduledFromId: string | null;
      };
      creditReleased: boolean;
    })
  | { status: "cutoffPassed" }
> {
  const student = await tx.studentProfile.findFirst({
    where:
      actor.role === "STUDENT"
        ? { userId: actor.userId }
        : { id: input.studentId },
    select: {
      id: true,
      userId: true,
      user: { select: { name: true } },
    },
  });
  if (!student) throw notFound();
  if (
    actor.role === "STUDENT" &&
    input.studentId !== undefined &&
    input.studentId !== student.id
  ) {
    throw notFound();
  }

  const lesson = await tx.lesson.findFirst({
    where: { id: input.lessonId },
    select: {
      id: true,
      groupId: true,
      teacherId: true,
      roomId: true,
      timetableSlotId: true,
      startsAt: true,
      endsAt: true,
      status: true,
      rescheduledFromId: true,
      term: { select: { timetablePublishedAt: true } },
      group: { select: { type: true } },
      spentCredit: {
        select: { id: true, status: true, expiresAt: true, studentId: true },
      },
    },
  });
  if (!lesson) throw notFound();
  const [memberships, replacements, existing] = await Promise.all([
    tx.groupMembership.findMany({
      where: { studentId: student.id, groupId: lesson.groupId },
      select: { groupId: true, joinedAt: true, leftAt: true },
    }),
    tx.replacementRequest.count({
      where: {
        studentId: student.id,
        targetLessonId: lesson.id,
        status: { in: [...ACTIVE_REPLACEMENT] },
      },
    }),
    tx.absenceReport.count({
      where: { studentId: student.id, lessonId: lesson.id },
    }),
  ]);
  const reasons = checkAbsence(
    {
      lesson: {
        startsAt: lesson.startsAt,
        status: lesson.status,
        published: lesson.term.timetablePublishedAt !== null,
      },
      isMember: isMemberAt(memberships, lesson.groupId, lesson.startsAt),
      hasActiveReplacement: replacements > 0,
      alreadyReported: existing > 0,
    },
    now,
  );
  // Lessons the student doesn't take part in don't exist for them.
  if (reasons.includes("NOT_PUBLISHED") || reasons.includes("NOT_A_MEMBER")) {
    throw notFound();
  }
  if (reasons.length > 0) throw refusal(reasons[0]);

  const oneOnOne = lesson.group.type === "ONE_ON_ONE";
  const spent =
    oneOnOne && lesson.spentCredit?.status === "USED"
      ? lesson.spentCredit
      : null;
  // An admin-moved 1-on-1 counts its credit's validity from the chain root.
  const anchor =
    oneOnOne && !spent && lesson.rescheduledFromId
      ? await chainRoot(tx, lesson)
      : lesson;
  const plan = planAbsence(
    { startsAt: lesson.startsAt, type: lesson.group.type },
    school,
    school.timezone,
    now,
  );
  const creditPlan =
    plan.credit && anchor !== lesson
      ? creditExpiry(
          anchor.startsAt,
          school.makeupCreditValidDays,
          school.timezone,
        )
      : plan.credit;
  if (input.expectCredit && !plan.earnsCredit) {
    return { status: "cutoffPassed" };
  }

  let absenceId: string;
  try {
    const report = await tx.absenceReport.create({
      data: {
        schoolId: school.id,
        lessonId: lesson.id,
        studentId: student.id,
        reportedById: actor.userId,
        reason: input.reason,
        createdAt: now,
      },
      select: { id: true },
    });
    absenceId = report.id;
  } catch (error) {
    if (isUniqueViolation(error)) throw refusal("ALREADY_REPORTED");
    throw error;
  }

  let credit: { id: string; validUntil: string } | null = null;
  let creditReleased = false;
  if (spent) {
    // Never a new credit: in time the spent one comes back (§3).
    if (plan.earnsCredit) {
      const released = await releaseSpentCredit(
        tx,
        spent,
        "STUDENT",
        school.timezone,
        now,
      );
      creditReleased = true;
      if (released.status === "AVAILABLE") {
        credit = {
          id: spent.id,
          validUntil: validUntilOf(released.expiresAt, school.timezone),
        };
      }
    }
  } else if (creditPlan) {
    const row = await tx.makeupCredit.create({
      data: {
        schoolId: school.id,
        studentId: student.id,
        sourceLessonId: lesson.id,
        absenceReportId: absenceId,
        expiresAt: creditPlan.expiresAt,
        createdAt: now,
      },
      select: { id: true },
    });
    credit = { id: row.id, validUntil: creditPlan.validUntil };
  }
  if (plan.cancelLesson) {
    await tx.lesson.updateMany({
      where: { id: lesson.id, status: "SCHEDULED" },
      data: { status: "CANCELLED", cancelReason: STUDENT_CANCELLED },
    });
  }
  await tx.auditLog.create({
    data: {
      schoolId: school.id,
      actorId: actor.userId,
      action: "absence.reported",
      entityType: "AbsenceReport",
      entityId: absenceId,
      data: {
        lessonId: lesson.id,
        studentId: student.id,
        byAdmin: actor.role === "ADMIN",
        creditId: credit?.id ?? null,
        creditReleased: creditReleased ? spent!.id : null,
        expiresAt: creditPlan?.expiresAt.toISOString() ?? null,
        lessonCancelled: plan.cancelLesson,
        cutoffMinutes: school.absenceCutoffMinutes,
      },
    },
  });
  return {
    status: "reported",
    absenceId,
    studentName: student.user.name,
    credit,
    lessonCancelled: plan.cancelLesson,
    lesson,
    creditReleased,
  };
}

export type DeleteAbsenceResult =
  | {
      status: "deleted";
      studentName: string;
      /** The 1-on-1 the absence had cancelled is scheduled again. */
      lessonRestored: boolean;
      /** Set when the group lesson is over its room's capacity now. */
      overCapacity: { group: string; taken: number; capacity: number } | null;
    }
  | {
      /** Restoring the 1-on-1 conflicts with the timetable (§3). */
      status: "conflicts";
      reason: "BLOCKING_CONFLICTS" | "UNACKNOWLEDGED_CONFLICTS";
      conflicts: Conflict[];
    };

/**
 * Deletes a mistaken absence (admin, §3): refused while its credit is
 * spent; otherwise the report and its credit go together. A 1-on-1 it had
 * cancelled is scheduled again, after the same conflict check as a lesson
 * move: blocking conflicts refuse, overridable ones need to be in
 * `acknowledgedConflictKeys`.
 */
export async function deleteAbsence(
  db: SchoolDb,
  actor: { userId: string },
  absenceId: string,
  acknowledgedConflictKeys: readonly string[],
  now: Date,
): Promise<DeleteAbsenceResult> {
  if (!isUuid(absenceId)) throw notFound();
  return inLockedTransaction(db, async (tx, school) => {
    const report = await tx.absenceReport.findFirst({
      where: { id: absenceId },
      select: {
        id: true,
        studentId: true,
        student: { select: { user: { select: { name: true } } } },
        makeupCredit: {
          select: { id: true, status: true, expiresAt: true },
        },
        lesson: {
          select: {
            id: true,
            termId: true,
            timetableSlotId: true,
            occurrenceDate: true,
            groupId: true,
            teacherId: true,
            substituteTeacherId: true,
            roomId: true,
            startsAt: true,
            endsAt: true,
            status: true,
            cancelReason: true,
            rescheduledFromId: true,
            rescheduledTo: { select: { id: true } },
            group: { select: { name: true, type: true } },
            room: { select: { capacity: true } },
          },
        },
      },
    });
    if (!report) throw notFound();
    const { lesson, makeupCredit: credit } = report;
    const restoresLesson =
      lesson.group.type === "ONE_ON_ONE" &&
      lesson.status === "CANCELLED" &&
      lesson.cancelReason === STUDENT_CANCELLED;
    const refused = checkAbsenceDelete({
      creditStatus: credit ? creditState(credit, now) : null,
      restoresLesson,
      lessonStartsAt: lesson.startsAt,
      now,
    });
    if (refused) throw refusal(refused);
    // A 1-on-1 in a reschedule chain isn't restored: it was moved on, or
    // its credit already came back (§3, §7). Move it with Reschedule.
    if (
      restoresLesson &&
      (lesson.rescheduledTo !== null || lesson.rescheduledFromId !== null)
    ) {
      throw refusal("ABSENCE_RESCHEDULED");
    }

    let overridden: Conflict[] = [];
    if (restoresLesson) {
      const conflicts = await checkLessonInTransaction(
        tx,
        {
          id: lesson.id,
          termId: lesson.termId,
          timetableSlotId: lesson.timetableSlotId,
          occurrenceDate: lesson.occurrenceDate
            ? lesson.occurrenceDate.toISOString().slice(0, 10)
            : null,
          groupId: lesson.groupId,
          teacherId: lesson.teacherId,
          substituteTeacherId: lesson.substituteTeacherId,
          roomId: lesson.roomId,
          startsAt: lesson.startsAt,
          endsAt: lesson.endsAt,
        },
        now,
      );
      const decision = decideSave(conflicts, acknowledgedConflictKeys);
      if (!decision.ok) {
        return { status: "conflicts", reason: decision.reason, conflicts };
      }
      overridden = decision.overridden;
    }

    if (credit) {
      // Conditional: a credit spent meanwhile is never deleted.
      const { count } = await tx.makeupCredit.deleteMany({
        where: { id: credit.id, status: { not: "USED" } },
      });
      if (count === 0) throw refusal("ABSENCE_CREDIT_USED");
    }
    await tx.absenceReport.delete({ where: { id: report.id } });
    if (restoresLesson) {
      await tx.lesson.updateMany({
        where: { id: lesson.id, status: "CANCELLED" },
        data: { status: "SCHEDULED", cancelReason: null },
      });
    }

    let overCapacity: Extract<
      DeleteAbsenceResult,
      { status: "deleted" }
    >["overCapacity"] = null;
    const capacity = lesson.room?.capacity ?? null;
    if (lesson.group.type === "GROUP" && capacity !== null) {
      const taken = await seatsOf(tx, lesson);
      if (taken > capacity) {
        overCapacity = { group: lesson.group.name, taken, capacity };
      }
    }

    await tx.auditLog.create({
      data: {
        schoolId: school.id,
        actorId: actor.userId,
        action: "absence.deleted",
        entityType: "AbsenceReport",
        entityId: report.id,
        data: JSON.parse(
          JSON.stringify({
            lessonId: lesson.id,
            studentId: report.studentId,
            creditId: credit?.id ?? null,
            creditStatus: credit ? creditState(credit, now) : null,
            lessonRestored: restoresLesson,
            overriddenConflicts: overridden.map((c) => ({
              type: c.type,
              key: c.key,
              params: c.params,
            })),
          }),
        ),
      },
    });
    return {
      status: "deleted",
      studentName: report.student.user.name,
      lessonRestored: restoresLesson,
      overCapacity,
    };
  });
}

/** `seatsTaken` of one lesson (§5), read inside a transaction. */
async function seatsOf(
  tx: Tx,
  lesson: { id: string; groupId: string; startsAt: Date },
): Promise<number> {
  const [memberships, absences, replacements] = await Promise.all([
    tx.groupMembership.findMany({
      where: { groupId: lesson.groupId },
      select: { studentId: true, joinedAt: true, leftAt: true },
    }),
    tx.absenceReport.findMany({
      where: { lessonId: lesson.id },
      select: { studentId: true },
    }),
    tx.replacementRequest.findMany({
      where: {
        targetLessonId: lesson.id,
        status: { in: [...ACTIVE_REPLACEMENT] },
      },
      select: { studentId: true },
    }),
  ]);
  return seatsTaken({
    memberIds: membersAt(memberships, lesson.startsAt).map((m) => m.studentId),
    absentIds: absences.map((a) => a.studentId),
    replacementIds: replacements.map((r) => r.studentId),
  });
}

/**
 * Brings stored credit statuses up to date (§4): an idempotent,
 * school-scoped update with the request's `now`, run when a student or
 * admin list loads. Reads use `creditState` anyway.
 */
export async function expireCredits(db: SchoolDb, now: Date): Promise<number> {
  const { count } = await db.makeupCredit.updateMany({
    where: { status: "AVAILABLE", expiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });
  return count;
}

/** The local date of an instant in the school's time zone. */
export const localDate = (instant: Date, timeZone: string) =>
  toZonedDateTime(instant, timeZone).date;
