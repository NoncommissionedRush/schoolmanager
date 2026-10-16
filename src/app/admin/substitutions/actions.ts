"use server";

import { revalidatePath, updateTag } from "next/cache";

import { saveException } from "@/server/admin/availability/service";
import { exceptionSchema } from "@/server/admin/availability/schema";
import { runAdminAction } from "@/server/admin/context";
import { type ActionResult, ok } from "@/server/admin/result";
import { assertIds } from "@/server/admin/shared";
import { parseInput } from "@/server/admin/validation";
import {
  type AssignSubstituteInput,
  assignSubstituteSchema,
  type CoverTeacherInput,
  coverTeacherSchema,
  type RemoveSubstituteInput,
  removeSubstituteSchema,
} from "@/server/substitutes/schema";
import { needsCoverTag } from "@/server/substitutes/cache";
import {
  assignSubstitute,
  loadSubstituteSheet,
  removeSubstitute,
  type SubstituteActionResult,
  type SubstituteSheet,
} from "@/server/substitutes/service";

// Substitute actions (phase5-rules.md §3.5). Admin-only: `runAdminAction`
// re-checks the role; every lesson and teacher id is looked up through the
// school-scoped client, so another school's id is "not found".

function revalidate(schoolId: string, lessonId: string) {
  updateTag(needsCoverTag(schoolId));
  revalidatePath("/admin/substitutions");
  revalidatePath(`/admin/lessons/${lessonId}`);
  revalidatePath("/admin");
}

/** The _Find a substitute_ sheet for one lesson (design §5.3). */
export async function loadSubstituteSheetAction(
  lessonId: string,
): Promise<ActionResult<SubstituteSheet>> {
  return runAdminAction(async ({ db, viewer }) => {
    assertIds(lessonId);
    return ok(
      await loadSubstituteSheet(db, viewer, String(lessonId), new Date()),
    );
  });
}

export async function assignSubstituteAction(
  input: AssignSubstituteInput,
): Promise<ActionResult<SubstituteActionResult>> {
  return runAdminAction(async ({ db, viewer }) => {
    const parsed = parseInput(assignSubstituteSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const result = await assignSubstitute(db, viewer, parsed.data, new Date());
    if (result.status === "done") {
      revalidate(viewer.school.id, parsed.data.lessonId);
    }
    return ok(result);
  });
}

export async function removeSubstituteAction(
  input: RemoveSubstituteInput,
): Promise<ActionResult<SubstituteActionResult>> {
  return runAdminAction(async ({ db, viewer }) => {
    const parsed = parseInput(removeSubstituteSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const result = await removeSubstitute(db, viewer, parsed.data, new Date());
    if (result.status === "done") {
      revalidate(viewer.school.id, parsed.data.lessonId);
    }
    return ok(result);
  });
}

/**
 * _Cover a teacher_ (design §5.2): optionally marks the teacher away on
 * every date of the range through the availability service (same
 * validation and audit), before the list loads with their lessons.
 */
export async function coverTeacherAction(
  input: CoverTeacherInput,
): Promise<ActionResult<{ marked: number }>> {
  return runAdminAction(async (context) => {
    const parsed = parseInput(coverTeacherSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const { teacherId, from, to, markAway } = parsed.data;
    if (!markAway) return ok({ marked: 0 });
    const exception = parseInput(exceptionSchema, {
      kind: "DATE_UNAVAILABLE",
      date: from,
      dateTo: to,
      wholeDay: true,
      from: "",
      to: "",
      note: null,
    });
    if (!exception.ok) {
      return {
        ok: false,
        fieldErrors: { to: Object.values(exception.fieldErrors)[0] },
      };
    }
    await saveException(
      context,
      teacherId,
      exception.data,
      context.viewer.school.timezone,
    );
    updateTag(needsCoverTag(context.viewer.school.id));
    revalidatePath("/admin/substitutions");
    return ok({ marked: exception.data.dates.length });
  });
}
