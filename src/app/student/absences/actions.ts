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
  type CancelLessonInput,
  cancelLessonSchema,
} from "@/server/replacements/schema";
import {
  reportAbsence,
  type ReportAbsenceResult,
} from "@/server/replacements/service";

/**
 * "Can't attend?" (absences.md §5.2): the signed-in student cancels one of
 * their own upcoming lessons. The service re-checks every rule at submit
 * time; a lesson that isn't theirs is "not found".
 */
export async function cancelLessonAction(
  input: CancelLessonInput,
): Promise<ActionResult<ReportAbsenceResult>> {
  const viewer = await requireRole("STUDENT");
  const parsed = parseInput(cancelLessonSchema, input);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
  try {
    const result = await reportAbsence(
      scopeToSchool(db, viewer.school.id),
      { userId: viewer.userId, role: "STUDENT" },
      parsed.data,
      new Date(),
    );
    if (result.status === "reported") revalidatePath("/student", "layout");
    return ok(result);
  } catch (error) {
    if (error instanceof AdminError) return toFailure(error);
    throw error;
  }
}
