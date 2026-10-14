// Slot splits (docs/architecture/replacements.md §5 _Slot splits_): what an
// old-slot lesson hands to its successor in the new slot. Called by the
// timetable service inside its locked transaction, after the successors
// were created and before the old lessons are cancelled or deleted.

import type { CarryOver } from "@/server/scheduling";
import type { Tx } from "@/server/timetable/service";

import { carryOverBookings } from "./booking";

export type CarryOverMove = Pick<
  CarryOver,
  "fromLessonId" | "cancelSuccessor"
> & {
  toLessonId: string;
};

export type CarryOverResult = {
  /** `fromLessonId → toLessonId` pairs, as the audit log records them. */
  lessons: { from: string; to: string; cancelled: string | null }[];
  absences: number;
  bookingsMoved: string[];
  /** Released with grace when their old lesson is cancelled right after. */
  bookingsLeft: string[];
};

/**
 * For each pair: a cancelled 1-on-1's successor is cancelled with the same
 * reason; absences, their credits' source and the bookings they back move
 * to the successor (no new credit, same expiry), and so does a rescheduled
 * lesson's `rescheduledFromId`. Then active bookings into a group lesson
 * follow it when the successor still accepts them (`carryOverBookings`).
 */
export async function carryOverSlotSplit(
  tx: Tx,
  schoolId: string,
  moves: readonly CarryOverMove[],
  now: Date,
): Promise<CarryOverResult> {
  let absences = 0;
  for (const { fromLessonId: from, toLessonId: to, cancelSuccessor } of moves) {
    if (cancelSuccessor) {
      await tx.lesson.update({
        where: { id: to },
        data: { status: "CANCELLED", cancelReason: cancelSuccessor },
      });
    }
    const moved = await tx.absenceReport.updateMany({
      where: { lessonId: from },
      data: { lessonId: to },
    });
    absences += moved.count;
    await tx.makeupCredit.updateMany({
      where: { sourceLessonId: from },
      data: { sourceLessonId: to },
    });
    await tx.replacementRequest.updateMany({
      where: { originalLessonId: from },
      data: { originalLessonId: to },
    });
    await tx.lesson.updateMany({
      where: { rescheduledFromId: from },
      data: { rescheduledFromId: to },
    });
  }
  const bookings = await carryOverBookings(
    tx,
    schoolId,
    moves.filter((m) => m.cancelSuccessor === null),
    now,
  );
  return {
    lessons: moves.map((m) => ({
      from: m.fromLessonId,
      to: m.toLessonId,
      cancelled: m.cancelSuccessor,
    })),
    absences,
    bookingsMoved: bookings.moved,
    bookingsLeft: bookings.left,
  };
}
