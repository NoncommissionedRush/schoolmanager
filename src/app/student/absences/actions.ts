"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import {
  type ActionResult,
  AdminError,
  ok,
  toFailure,
} from "@/server/admin/result";
import { parseInput } from "@/server/admin/validation";
import { requireRole } from "@/server/auth/session";
import { scopeToSchool } from "@/server/db/school-scope";
import {
  type BookResult,
  bookReplacement,
  cancelBooking,
  type CancelBookingResult,
} from "@/server/replacements/booking";
import {
  loadRescheduleSheet,
  type RescheduleResult,
  type RescheduleSheet,
  rescheduleLesson,
} from "@/server/replacements/reschedule";
import {
  bookReplacementSchema,
  cancelBookingSchema,
  type CancelLessonInput,
  cancelLessonSchema,
  rescheduleSchema,
  rescheduleSourceSchema,
} from "@/server/replacements/schema";
import {
  reportAbsence,
  type ReportAbsenceResult,
} from "@/server/replacements/service";

// Student actions for absences, bookings and reschedules (absences.md §5).
// Each re-checks the role and runs every rule again in the service; a
// lesson, credit or booking that isn't the student's own is "not found".

async function runStudentAction<T>(
  action: (context: {
    db: ReturnType<typeof scopeToSchool>;
    userId: string;
  }) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  const viewer = await requireRole("STUDENT");
  try {
    return await action({
      db: scopeToSchool(db, viewer.school.id),
      userId: viewer.userId,
    });
  } catch (error) {
    if (error instanceof AdminError) return toFailure(error);
    throw error;
  }
}

/**
 * "Can't attend?" (absences.md §5.2): the signed-in student cancels one of
 * their own upcoming lessons. The service re-checks every rule at submit
 * time; a lesson that isn't theirs is "not found".
 */
export async function cancelLessonAction(
  input: CancelLessonInput,
): Promise<ActionResult<ReportAbsenceResult>> {
  return runStudentAction(async ({ db, userId }) => {
    const parsed = parseInput(cancelLessonSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const result = await reportAbsence(
      db,
      { userId, role: "STUDENT" },
      parsed.data,
      new Date(),
    );
    if (result.status === "reported") revalidatePath("/student", "layout");
    return ok(result);
  });
}

/** Books a replacement with one of the student's credits (§5.5). */
export async function bookReplacementAction(input: {
  creditId: string;
  targetLessonId: string;
}): Promise<ActionResult<BookResult>> {
  return runStudentAction(async ({ db, userId }) => {
    const parsed = parseInput(bookReplacementSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const result = await bookReplacement(
      db,
      { userId },
      parsed.data,
      new Date(),
    );
    if (result.status === "booked") revalidatePath("/student", "layout");
    return ok(result);
  });
}

/** Cancels one of the student's replacement bookings (§5.7). */
export async function cancelBookingAction(input: {
  bookingId: string;
}): Promise<ActionResult<CancelBookingResult>> {
  return runStudentAction(async ({ db, userId }) => {
    const parsed = parseInput(cancelBookingSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const result = await cancelBooking(
      db,
      { userId },
      parsed.data.bookingId,
      new Date(),
    );
    revalidatePath("/student", "layout");
    return ok(result);
  });
}

/** The Reschedule sheet's free times (§5.3). */
export async function loadRescheduleSheetAction(
  source: { lessonId: string } | { creditId: string },
): Promise<ActionResult<RescheduleSheet>> {
  return runStudentAction(async ({ db, userId }) => {
    const parsed = parseInput(rescheduleSourceSchema, source);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    return ok(
      await loadRescheduleSheet(db, { userId }, parsed.data, new Date()),
    );
  });
}

/** Moves a 1-on-1 to one of the offered times (§5.3). */
export async function rescheduleLessonAction(
  input: ({ lessonId: string } | { creditId: string }) & { startsAt: string },
): Promise<ActionResult<RescheduleResult>> {
  return runStudentAction(async ({ db, userId }) => {
    const parsed = parseInput(rescheduleSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const result = await rescheduleLesson(
      db,
      { userId },
      parsed.data,
      new Date(),
    );
    if (result.status === "rescheduled") revalidatePath("/student", "layout");
    return ok(result);
  });
}
