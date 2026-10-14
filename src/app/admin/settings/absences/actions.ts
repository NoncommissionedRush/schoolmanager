"use server";

import { revalidatePath } from "next/cache";

import { absenceSettingsSchema } from "@/server/admin/absence-settings/schema";
import { updateAbsenceSettings } from "@/server/admin/absence-settings/service";
import { runAdminAction } from "@/server/admin/context";
import { type ActionResult, msg, ok } from "@/server/admin/result";
import { formDataToObject, parseInput } from "@/server/admin/validation";

export async function saveAbsenceSettingsAction(
  _previous: ActionResult<{ updatedAt: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ updatedAt: string }>> {
  return runAdminAction(async (scope) => {
    const input = formDataToObject(formData);
    const parsed = parseInput(absenceSettingsSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const expected =
      typeof input.updatedAt === "string" ? input.updatedAt : null;
    const school = await updateAbsenceSettings(scope, parsed.data, expected);
    // Students see the policy and cutoffs on their timetable and Absences tab.
    revalidatePath("/", "layout");
    return ok(
      { updatedAt: school.updatedAt.toISOString() },
      msg("settings.absences.saved"),
    );
  });
}
