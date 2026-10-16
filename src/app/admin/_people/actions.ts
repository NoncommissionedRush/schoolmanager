"use server";

import { revalidatePath, updateTag } from "next/cache";

import { runAdminAction } from "@/server/admin/context";
import { setPasswordSchema } from "@/server/admin/people/schema";
import {
  archivePerson,
  restorePerson,
  setPassword,
} from "@/server/admin/people/service";
import { type ActionResult, msg, ok } from "@/server/admin/result";
import { assertIds, schoolToday } from "@/server/admin/shared";
import { formDataToObject, parseInput } from "@/server/admin/validation";
import { needsCoverTag } from "@/server/substitutes/cache";

/** Shared by teachers, students and admins (§5.3, §5.4). */

export type Credentials = { name: string; email: string; password: string };

export async function setPasswordAction(
  userId: string,
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<Credentials>> {
  return runAdminAction(async (scope) => {
    assertIds(userId);
    const parsed = parseInput(setPasswordSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const user = await setPassword(scope, userId, parsed.data.password);
    revalidatePath("/admin", "layout");
    // Shown once in the credentials dialog; never stored or logged.
    return ok({
      name: user.name,
      email: user.email,
      password: parsed.data.password,
    });
  });
}

export async function archivePersonAction(userId: string) {
  return runAdminAction(async (scope) => {
    assertIds(userId);
    const result = await archivePerson(
      scope,
      userId,
      schoolToday(scope.viewer.school.timezone),
    );
    // An archived teacher's lessons need cover (phase5-rules.md §3.7).
    updateTag(needsCoverTag(scope.viewer.school.id));
    revalidatePath("/admin", "layout");
    return ok({ name: result.user.name });
  });
}

export async function restorePersonAction(userId: string) {
  return runAdminAction(async (scope) => {
    assertIds(userId);
    const user = await restorePerson(scope, userId);
    updateTag(needsCoverTag(scope.viewer.school.id));
    revalidatePath("/admin", "layout");
    return ok(undefined, msg("common.toast.restored", { name: user.name }));
  });
}
