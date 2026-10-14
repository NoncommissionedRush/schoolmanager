"use server";

import { revalidatePath } from "next/cache";

import { runAdminAction } from "@/server/admin/context";
import { type ActionResult, msg, ok } from "@/server/admin/result";
import { schoolSettingsSchema } from "@/server/admin/school/schema";
import { updateSchoolSettings } from "@/server/admin/school/service";
import { formDataToObject, parseInput } from "@/server/admin/validation";

export async function saveSchoolSettingsAction(
  _previous: ActionResult<{ updatedAt: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ updatedAt: string }>> {
  return runAdminAction(async (scope) => {
    const input = formDataToObject(formData);
    const parsed = parseInput(schoolSettingsSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const expected =
      typeof input.updatedAt === "string" ? input.updatedAt : null;
    const school = await updateSchoolSettings(scope, parsed.data, expected);
    // The school name and hours show across the app shell and timetable.
    revalidatePath("/", "layout");
    return ok(
      { updatedAt: school.updatedAt.toISOString() },
      msg("common.toast.saved"),
    );
  });
}
