"use server";

import { revalidatePath } from "next/cache";

import { runAdminAction } from "@/server/admin/context";
import { type ActionResult, msg, ok } from "@/server/admin/result";
import { assertIds } from "@/server/admin/shared";
import { parseInput } from "@/server/admin/validation";
import {
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
