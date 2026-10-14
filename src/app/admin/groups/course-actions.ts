"use server";

import { revalidatePath } from "next/cache";

import { runAdminAction } from "@/server/admin/context";
import { courseSchema } from "@/server/admin/courses/schema";
import {
  createCourse,
  deleteCourse,
  updateCourse,
} from "@/server/admin/courses/service";
import { type ActionResult, msg, ok } from "@/server/admin/result";
import { formDataToObject, parseInput } from "@/server/admin/validation";

const refresh = () => revalidatePath("/admin/groups", "layout");

export async function saveCourseAction(
  id: string | null,
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<{ id: string; name: string }>> {
  return runAdminAction(async (scope) => {
    const parsed = parseInput(courseSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const course = id
      ? await updateCourse(scope, id, parsed.data)
      : await createCourse(scope, parsed.data);
    refresh();
    return ok(
      course,
      id
        ? msg("common.toast.saved")
        : msg("common.toast.created", { name: course.name }),
    );
  });
}

export async function deleteCourseAction(id: string) {
  return runAdminAction(async (scope) => {
    const course = await deleteCourse(scope, id);
    refresh();
    return ok(undefined, msg("common.toast.deleted", { name: course.name }));
  });
}
