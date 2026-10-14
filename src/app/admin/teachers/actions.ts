"use server";

import { revalidatePath } from "next/cache";

import type { Credentials } from "@/app/admin/_people/actions";
import {
  exceptionSchema,
  weeklySchema,
} from "@/server/admin/availability/schema";
import {
  deleteAvailability,
  saveException,
  saveWeekly,
} from "@/server/admin/availability/service";
import { runAdminAction } from "@/server/admin/context";
import {
  createTeacherSchema,
  updateTeacherSchema,
} from "@/server/admin/people/schema";
import { type ActionResult, msg, ok } from "@/server/admin/result";
import { createTeacher, updateTeacher } from "@/server/admin/teachers/service";
import { formDataToObject, parseInput } from "@/server/admin/validation";

const PATH = "/admin/teachers";

export async function createTeacherAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<Credentials & { id: string }>> {
  return runAdminAction(async (scope) => {
    const parsed = parseInput(createTeacherSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const teacher = await createTeacher(scope, parsed.data);
    revalidatePath(PATH, "layout");
    // The password goes back once, for the credentials dialog (§5.4).
    return ok(
      {
        id: teacher.id,
        name: parsed.data.name,
        email: parsed.data.email,
        password: parsed.data.password,
      },
      msg("common.toast.created", { name: parsed.data.name }),
    );
  });
}

export async function updateTeacherAction(
  teacherId: string,
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<{ updatedAt: string }>> {
  return runAdminAction(async (scope) => {
    const parsed = parseInput(updateTeacherSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const teacher = await updateTeacher(scope, teacherId, parsed.data);
    revalidatePath(PATH, "layout");
    return ok({ updatedAt: teacher.updatedAt }, msg("common.toast.saved"));
  });
}

export async function saveWeeklyAction(
  teacherId: string,
  replaceId: string | null,
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<{ mergedWeekdays: number[] }>> {
  return runAdminAction(async (scope) => {
    const parsed = parseInput(weeklySchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const result = await saveWeekly(scope, teacherId, parsed.data, replaceId);
    revalidatePath(`${PATH}/${teacherId}`);
    const merged = result.mergedWeekdays[0];
    return ok(
      result,
      merged
        ? msg("availability.weekly.merged", {
            weekday: msg(`common.weekday.${merged}`),
          })
        : msg("common.toast.saved"),
    );
  });
}

export async function saveExceptionAction(
  teacherId: string,
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<{ affected: number }>> {
  return runAdminAction(async (scope) => {
    const parsed = parseInput(exceptionSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const result = await saveException(
      scope,
      teacherId,
      parsed.data,
      scope.viewer.school.timezone,
    );
    revalidatePath(`${PATH}/${teacherId}`);
    // With affected lessons the client shows its own toast with a link.
    return ok(
      result,
      result.affected > 0 ? undefined : msg("common.toast.saved"),
    );
  });
}

export async function deleteAvailabilityAction(teacherId: string, id: string) {
  return runAdminAction(async (scope) => {
    await deleteAvailability(scope, teacherId, id);
    revalidatePath(`${PATH}/${teacherId}`);
    return ok(undefined, msg("availability.deleted"));
  });
}
