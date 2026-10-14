"use server";

import { revalidatePath } from "next/cache";

import type { Credentials } from "@/app/admin/_people/actions";
import { runAdminAction } from "@/server/admin/context";
import {
  createStudentSchema,
  updateStudentSchema,
} from "@/server/admin/people/schema";
import {
  type ActionResult,
  type Message,
  msg,
  ok,
} from "@/server/admin/result";
import { schoolToday } from "@/server/admin/shared";
import { createStudent, updateStudent } from "@/server/admin/students/service";
import { formDataToObject, parseInput } from "@/server/admin/validation";

const refresh = () => revalidatePath("/admin", "layout");

type Created = Credentials & { id: string; warnings: Message[] };

export async function createStudentAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<Created>> {
  return runAdminAction(async (scope) => {
    const parsed = parseInput(createStudentSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const student = await createStudent(
      scope,
      parsed.data,
      schoolToday(scope.viewer.school.timezone),
    );
    refresh();
    // The password is shown once in the credentials dialog; never stored.
    return ok(
      {
        id: student.id,
        warnings: student.warnings,
        name: parsed.data.name,
        email: parsed.data.email,
        password: parsed.data.password,
      },
      msg("common.toast.created", { name: parsed.data.name }),
    );
  });
}

export async function updateStudentAction(
  id: string,
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<{ id: string; name: string }>> {
  return runAdminAction(async (scope) => {
    const parsed = parseInput(updateStudentSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const student = await updateStudent(scope, id, parsed.data);
    refresh();
    return ok(student, msg("common.toast.saved"));
  });
}
