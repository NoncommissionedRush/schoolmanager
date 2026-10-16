// Giving spent credits back (docs/architecture/replacements.md §4). Used by
// the booking and reschedule services and by the timetable service when it
// cancels lessons, always inside the caller's locked transaction and with
// the caller's `now`. Imports only types from the timetable service, so
// that service can call it without an import cycle.

import { notifyReplacementEnded } from "@/server/notifications/emit";
import { recordReleased } from "@/server/notifications/timetable-changes";
import { type ReleaseCause, releaseCredit } from "@/server/scheduling";
import type { Tx } from "@/server/timetable/service";

/** Replacement statuses that hold a seat (§1 "active"). */
export const ACTIVE_REPLACEMENT = [
  "AUTO_APPROVED",
  "APPROVED",
  "OVERRIDDEN",
] as const;

/**
 * Releases one spent credit: AVAILABLE again (or EXPIRED for a student's
 * own late release past its expiry), `usedAt` and the rescheduled-lesson
 * link cleared. Returns the new state for messages and the audit log.
 */
export async function releaseSpentCredit(
  tx: Tx,
  credit: { id: string; expiresAt: Date },
  cause: ReleaseCause,
  timeZone: string,
  now: Date,
) {
  const next = releaseCredit(credit, cause, timeZone, now);
  await tx.makeupCredit.update({
    where: { id: credit.id },
    data: {
      status: next.status,
      expiresAt: next.expiresAt,
      usedAt: null,
      rescheduledLessonId: null,
    },
  });
  return next;
}

/**
 * The school cancelled `lessonIds` (holiday, timetable change, an admin):
 * their active bookings are released (`CANCELLED`, `LESSON_CANCELLED`) and
 * every credit spent on them or on a cancelled rescheduled 1-on-1 comes
 * back with grace. Audited without an actor (system release).
 */
export async function releaseCancelledLessons(
  tx: Tx,
  schoolId: string,
  lessonIds: readonly string[],
  timeZone: string,
  now: Date,
  actorId: string | null = null,
): Promise<{ bookings: number; credits: number }> {
  if (lessonIds.length === 0) return { bookings: 0, credits: 0 };
  const [bookings, rescheduled] = await Promise.all([
    tx.replacementRequest.findMany({
      where: {
        targetLessonId: { in: [...lessonIds] },
        status: { in: [...ACTIVE_REPLACEMENT] },
      },
      select: {
        id: true,
        status: true,
        targetLessonId: true,
        studentId: true,
        makeupCredit: { select: { id: true, expiresAt: true } },
      },
    }),
    tx.makeupCredit.findMany({
      where: { rescheduledLessonId: { in: [...lessonIds] }, status: "USED" },
      select: { id: true, expiresAt: true, rescheduledLessonId: true },
    }),
  ]);
  for (const booking of bookings) {
    await tx.replacementRequest.update({
      where: { id: booking.id },
      data: {
        status: "CANCELLED",
        cancelledAt: now,
        cancelReason: "LESSON_CANCELLED",
      },
    });
    const credit = await releaseSpentCredit(
      tx,
      booking.makeupCredit,
      "SCHOOL",
      timeZone,
      now,
    );
    const audit = await tx.auditLog.create({
      data: {
        schoolId,
        actorId,
        action: "replacement.cancelled",
        entityType: "ReplacementRequest",
        entityId: booking.id,
        data: {
          reason: "LESSON_CANCELLED",
          previousStatus: booking.status,
          targetLessonId: booking.targetLessonId,
          studentId: booking.studentId,
          creditId: booking.makeupCredit.id,
          creditExpiresAt: credit.expiresAt.toISOString(),
        },
      },
      select: { id: true },
    });
    // The student hears it from the booking, not as a cancelled lesson
    // (phase5-rules.md §2.2); the teacher is told about the lesson itself.
    recordReleased(tx, booking.targetLessonId, booking.studentId);
    await notifyReplacementEnded(
      tx,
      { sourceId: audit.id, actorId },
      {
        lessonId: booking.targetLessonId,
        studentId: booking.studentId,
        outcome: "cancelled",
        creditBack: credit.status === "AVAILABLE",
        only: "student",
      },
      now,
    );
  }
  for (const credit of rescheduled) {
    const next = await releaseSpentCredit(tx, credit, "SCHOOL", timeZone, now);
    await tx.auditLog.create({
      data: {
        schoolId,
        actorId,
        action: "credit.released",
        entityType: "MakeupCredit",
        entityId: credit.id,
        data: {
          reason: "LESSON_CANCELLED",
          lessonId: credit.rescheduledLessonId,
          expiresAt: next.expiresAt.toISOString(),
        },
      },
    });
  }
  return { bookings: bookings.length, credits: rescheduled.length };
}
