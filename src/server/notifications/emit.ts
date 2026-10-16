// The per-lesson notifications of single changes (docs/architecture/
// phase5-rules.md §2.2, §2.3): each helper loads what the rules need about
// the lesson as it is now in the caller's transaction and calls `notify`.
// Callers run them after their write and audit, inside the same locked
// transaction, with the audit row as the source.

import type { Tx } from "@/server/timetable/service";

import type { PersonRef } from "./rules";
import {
  adminIds,
  loadLessonFact,
  type NotifySource,
  notify,
  studentPerson,
} from "./service";

async function groupNameOf(tx: Tx, lessonId: string | null): Promise<string> {
  if (!lessonId) return "";
  const row = await tx.lesson.findFirst({
    where: { id: lessonId },
    select: { group: { select: { name: true } } },
  });
  return row?.group.name ?? "";
}

async function roomName(tx: Tx, roomId: string | null): Promise<string | null> {
  if (!roomId) return null;
  const row = await tx.room.findFirst({
    where: { id: roomId },
    select: { name: true },
  });
  return row?.name ?? null;
}

/** A school (admin) cancellation of one lesson (`LESSON_CANCELLED`). */
export async function notifyLessonCancelled(
  tx: Tx,
  source: NotifySource,
  input: { lessonId: string; reason: string },
  now: Date,
) {
  const lesson = await loadLessonFact(tx, input.lessonId);
  if (!lesson) return 0;
  return notify(
    tx,
    source,
    [{ type: "LESSON_CANCELLED", lesson, reason: input.reason }],
    now,
  );
}

/**
 * One lesson moved, or a 1-on-1 rescheduled to a new lesson
 * (`LESSON_MOVED`, link to the new one). `teachersOnly` for a student's own
 * reschedule.
 */
export async function notifyLessonMoved(
  tx: Tx,
  source: NotifySource,
  input: {
    lessonId: string;
    old: { startsAt: Date; endsAt: Date; roomId: string | null };
    teachersOnly?: boolean;
  },
  now: Date,
) {
  const lesson = await loadLessonFact(tx, input.lessonId);
  if (!lesson) return 0;
  return notify(
    tx,
    source,
    [
      {
        type: "LESSON_MOVED",
        lesson,
        old: {
          startsAt: input.old.startsAt,
          endsAt: input.old.endsAt,
          room: await roomName(tx, input.old.roomId),
        },
        teachersOnly: input.teachersOnly,
      },
    ],
    now,
  );
}

/** `SUBSTITUTE_REMOVED` to the substitute of a rescheduled-away lesson. */
export async function notifySubstituteDropped(
  tx: Tx,
  source: NotifySource,
  input: { lessonId: string; substitute: PersonRef },
  now: Date,
) {
  const lesson = await loadLessonFact(tx, input.lessonId);
  if (!lesson) return 0;
  return notify(
    tx,
    source,
    [
      {
        type: "SUBSTITUTE_REMOVED",
        lesson,
        removed: input.substitute,
        next: null,
        substituteOnly: true,
      },
    ],
    now,
  );
}

export async function notifyAbsenceReported(
  tx: Tx,
  source: NotifySource,
  input: {
    lessonId: string;
    studentId: string;
    withCredit: boolean;
    byAdmin: boolean;
  },
  now: Date,
) {
  const [lesson, student] = await Promise.all([
    loadLessonFact(tx, input.lessonId),
    studentPerson(tx, input.studentId),
  ]);
  if (!lesson || !student) return 0;
  return notify(
    tx,
    source,
    [
      {
        type: "ABSENCE_REPORTED",
        lesson,
        student,
        withCredit: input.withCredit,
        byAdmin: input.byAdmin,
      },
    ],
    now,
  );
}

/**
 * A replacement booking was made (`REPLACEMENT_BOOKED`); a student's own
 * booking also enters the admins' review queue (`REPLACEMENT_REVIEW_PENDING`).
 */
export async function notifyReplacementBooked(
  tx: Tx,
  source: NotifySource,
  input: {
    lessonId: string;
    studentId: string;
    originalLessonId: string | null;
    byAdmin: boolean;
  },
  now: Date,
) {
  const [lesson, student, fromGroup] = await Promise.all([
    loadLessonFact(tx, input.lessonId),
    studentPerson(tx, input.studentId),
    groupNameOf(tx, input.originalLessonId),
  ]);
  if (!lesson || !student) return 0;
  return notify(
    tx,
    source,
    [
      {
        type: "REPLACEMENT_BOOKED",
        lesson,
        student,
        fromGroup,
        byAdmin: input.byAdmin,
      },
      ...(input.byAdmin
        ? []
        : [
            {
              type: "REPLACEMENT_REVIEW_PENDING" as const,
              adminIds: await adminIds(tx),
            },
          ]),
    ],
    now,
  );
}

export async function notifyReplacementEnded(
  tx: Tx,
  source: NotifySource,
  input: {
    lessonId: string;
    studentId: string;
    outcome: "cancelled" | "rejected" | "moved";
    creditBack: boolean;
    note?: string | null;
    byStudent?: boolean;
    only?: "student" | "teacher";
  },
  now: Date,
) {
  const [lesson, student] = await Promise.all([
    loadLessonFact(tx, input.lessonId),
    studentPerson(tx, input.studentId),
  ]);
  if (!lesson || !student) return 0;
  return notify(
    tx,
    source,
    [
      {
        type: "REPLACEMENT_ENDED",
        lesson,
        student,
        outcome: input.outcome,
        creditBack: input.creditBack,
        note: input.note ?? null,
        byStudent: input.byStudent ?? false,
        only: input.only,
      },
    ],
    now,
  );
}

/**
 * An admin Override moved a booking to another lesson: the student gets
 * `REPLACEMENT_MOVED`, the new target's teacher `REPLACEMENT_BOOKED` and the
 * old target's teacher `REPLACEMENT_ENDED` (outcome `moved`).
 */
export async function notifyReplacementMoved(
  tx: Tx,
  source: NotifySource,
  input: {
    fromLessonId: string;
    toLessonId: string;
    studentId: string;
    originalLessonId: string | null;
    note: string | null;
  },
  now: Date,
) {
  const [from, to, student, fromGroup] = await Promise.all([
    loadLessonFact(tx, input.fromLessonId),
    loadLessonFact(tx, input.toLessonId),
    studentPerson(tx, input.studentId),
    groupNameOf(tx, input.originalLessonId),
  ]);
  if (!from || !to || !student) return 0;
  return notify(
    tx,
    source,
    [
      {
        type: "REPLACEMENT_MOVED",
        lesson: to,
        student,
        fromGroup: from.groupName,
        oldStartsAt: from.startsAt,
        note: input.note,
      },
      {
        type: "REPLACEMENT_BOOKED",
        lesson: to,
        student,
        fromGroup,
        // The student already has REPLACEMENT_MOVED.
        byAdmin: false,
      },
      {
        type: "REPLACEMENT_ENDED",
        lesson: from,
        student,
        outcome: "moved",
        creditBack: false,
        note: null,
        byStudent: false,
      },
    ],
    now,
  );
}
