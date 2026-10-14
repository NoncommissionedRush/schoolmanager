"use server";

import { revalidatePath } from "next/cache";

import { runAdminAction } from "@/server/admin/context";
import { type ActionResult, msg, ok } from "@/server/admin/result";
import { assertIds } from "@/server/admin/shared";
import { parseInput } from "@/server/admin/validation";
import {
  approveReplacements,
  listOverrideOptions,
  type OverrideOption,
  overrideReplacement,
  rejectReplacement,
  type ReviewResult,
} from "@/server/replacements/booking";
import {
  type AdminRescheduleResult,
  cancelRescheduledLesson,
  rescheduleByAdmin,
} from "@/server/replacements/reschedule";
import {
  type AdminRescheduleFormInput,
  adminRescheduleSchema,
  type OverrideReplacementInput,
  overrideReplacementSchema,
  type RejectReplacementInput,
  rejectReplacementSchema,
  type ReportAbsenceFormInput,
  reportAbsenceSchema,
} from "@/server/replacements/schema";
import {
  deleteAbsence,
  type DeleteAbsenceResult,
  reportAbsence,
  type ReportAbsenceResult,
} from "@/server/replacements/service";
import {
  listReportableLessons,
  type ReportableLesson,
} from "@/server/replacements/views";

/** The Report absence dialog's lesson list for one student (§7.5). */
export async function loadReportableLessonsAction(studentId: string): Promise<
  ActionResult<{
    student: { id: string; name: string };
    lessons: ReportableLesson[];
  }>
> {
  return runAdminAction(async ({ db }) => {
    assertIds(studentId);
    const result = await listReportableLessons(db, studentId, new Date());
    if (!result) return { ok: false, formError: msg("common.error.notFound") };
    return ok(result);
  });
}

/**
 * An admin reports an absence for a student (absences.md §7.5): the same
 * cutoff and credit rules as the student's own cancellation.
 */
export async function reportAbsenceAction(
  input: ReportAbsenceFormInput,
): Promise<ActionResult<ReportAbsenceResult>> {
  return runAdminAction(async ({ db, viewer }) => {
    const parsed = parseInput(reportAbsenceSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const result = await reportAbsence(
      db,
      { userId: viewer.userId, role: "ADMIN" },
      parsed.data,
      new Date(),
    );
    if (result.status === "reported") revalidatePath("/", "layout");
    return ok(result);
  });
}

/** Deletes a mistaken absence (§7.5, replacements.md §3). */
export async function deleteAbsenceAction(
  absenceId: string,
  acknowledgedConflictKeys: string[] = [],
): Promise<ActionResult<DeleteAbsenceResult>> {
  return runAdminAction(async ({ db, viewer }) => {
    assertIds(absenceId);
    const keys = Array.isArray(acknowledgedConflictKeys)
      ? acknowledgedConflictKeys.filter((k) => typeof k === "string")
      : [];
    const result = await deleteAbsence(
      db,
      { userId: viewer.userId },
      absenceId,
      keys,
      new Date(),
    );
    if (result.status === "deleted") revalidatePath("/", "layout");
    return ok(result);
  });
}

// ---------------------------------------------------------------------------
// Review and Replacements tabs (absences.md §7.3, CARM-43)
// ---------------------------------------------------------------------------

/** Approve one or several bookings without issues. */
export async function approveReplacementsAction(
  bookingIds: string[],
): Promise<ActionResult<ReviewResult & { count?: number }>> {
  return runAdminAction(async ({ db, viewer }) => {
    const ids = Array.isArray(bookingIds) ? bookingIds : [];
    assertIds(...ids);
    const result = await approveReplacements(
      db,
      { userId: viewer.userId },
      ids,
      new Date(),
    );
    if (result.status === "done") revalidatePath("/", "layout");
    return ok(result);
  });
}

/** Reject… with a reason: the credit goes back with grace. */
export async function rejectReplacementAction(
  input: RejectReplacementInput,
): Promise<ActionResult<ReviewResult & { validUntil?: string }>> {
  return runAdminAction(async ({ db, viewer }) => {
    const parsed = parseInput(rejectReplacementSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const result = await rejectReplacement(
      db,
      { userId: viewer.userId },
      parsed.data,
      new Date(),
    );
    if (result.status === "done") revalidatePath("/", "layout");
    return ok(result);
  });
}

/** Override…: keep or move a booking despite acknowledged reasons. */
export async function overrideReplacementAction(
  input: OverrideReplacementInput,
): Promise<ActionResult<ReviewResult & { startsAt?: string }>> {
  return runAdminAction(async ({ db, viewer }) => {
    const parsed = parseInput(overrideReplacementSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const result = await overrideReplacement(
      db,
      { userId: viewer.userId },
      parsed.data,
      new Date(),
    );
    if (result.status === "done") revalidatePath("/", "layout");
    return ok(result);
  });
}

/** The Override dialog's lesson picker. */
export async function loadOverrideOptionsAction(
  bookingId: string,
  showAll: boolean,
): Promise<
  ActionResult<{ current: OverrideOption; options: OverrideOption[] }>
> {
  return runAdminAction(async ({ db }) => {
    assertIds(bookingId);
    const result = await listOverrideOptions(
      db,
      bookingId,
      showAll === true,
      new Date(),
    );
    if (!result) return { ok: false, formError: msg("common.error.notFound") };
    return ok(result);
  });
}

// ---------------------------------------------------------------------------
// Admin reschedule of a 1-on-1 (replacements.md §7)
// ---------------------------------------------------------------------------

/** Moves a 1-on-1; conflicts come back for acknowledgement first. */
export async function rescheduleLessonAction(
  input: AdminRescheduleFormInput,
): Promise<ActionResult<AdminRescheduleResult>> {
  return runAdminAction(async ({ db, viewer }) => {
    const parsed = parseInput(adminRescheduleSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const result = await rescheduleByAdmin(
      db,
      { userId: viewer.userId },
      parsed.data,
      new Date(),
    );
    if (result.status === "rescheduled") revalidatePath("/", "layout");
    return ok(result);
  });
}

/** Cancels a rescheduled 1-on-1; its credit comes back with grace. */
export async function cancelRescheduledLessonAction(
  lessonId: string,
): Promise<ActionResult<{ creditReleased: boolean }>> {
  return runAdminAction(async ({ db, viewer }) => {
    assertIds(lessonId);
    const result = await cancelRescheduledLesson(
      db,
      { userId: viewer.userId },
      lessonId,
      new Date(),
    );
    revalidatePath("/", "layout");
    return ok(result);
  });
}
