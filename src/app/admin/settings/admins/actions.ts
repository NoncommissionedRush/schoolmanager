"use server";

import { revalidatePath } from "next/cache";

import type { Credentials } from "@/app/admin/_people/actions";
import { createAdmin } from "@/server/admin/admins/service";
import { runAdminAction } from "@/server/admin/context";
import { createAdminSchema } from "@/server/admin/people/schema";
import { type ActionResult, msg, ok } from "@/server/admin/result";
import { formDataToObject, parseInput } from "@/server/admin/validation";

export async function createAdminAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<Credentials>> {
  return runAdminAction(async (scope) => {
    const parsed = parseInput(createAdminSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    await createAdmin(scope, parsed.data);
    revalidatePath("/admin/settings/admins");
    // The password goes back once, for the credentials dialog (§5.4).
    return ok(
      {
        name: parsed.data.name,
        email: parsed.data.email,
        password: parsed.data.password,
      },
      msg("common.toast.created", { name: parsed.data.name }),
    );
  });
}
