"use server";

import { revalidatePath } from "next/cache";

import { runAdminAction } from "@/server/admin/context";
import { holidaySchema } from "@/server/admin/holidays/schema";
import { deleteHoliday, saveHoliday } from "@/server/admin/holidays/service";
import {
  type ActionResult,
  type Message,
  msg,
  ok,
} from "@/server/admin/result";
import { schoolToday } from "@/server/admin/shared";
import {
  type LessonChanges,
  lessonChangeParts,
} from "@/server/admin/terms/lesson-result";
import { termSchema } from "@/server/admin/terms/schema";
import {
  createTerm,
  deleteTerm,
  termContext,
  updateTerm,
} from "@/server/admin/terms/service";
import { toIsoDate } from "@/server/scheduling";
import { formDataToObject, parseInput } from "@/server/admin/validation";

const PATH = "/admin/settings/terms";

/** Lesson counts for the result toast; null when no published term changed. */
type LessonResult = Message[] | null;

const lessonResult = (lessons: LessonChanges | null): LessonResult =>
  lessons ? lessonChangeParts(lessons) : null;

type SavedTerm = {
  id: string;
  name: string;
  lessons: LessonResult;
};

export async function saveTermAction(
  id: string | null,
  _previous: ActionResult<SavedTerm> | null,
  formData: FormData,
): Promise<ActionResult<SavedTerm>> {
  return runAdminAction(async (scope) => {
    const today = toIsoDate(schoolToday(scope.viewer.school.timezone));
    const context = await termContext(scope.db, id, today);
    const parsed = parseInput(termSchema(context), formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const term = id
      ? await updateTerm(scope, id, parsed.data)
      : await createTerm(scope, parsed.data);
    revalidatePath(PATH);
    const data = { ...term, lessons: lessonResult(term.lessons) };
    // With lesson changes the client builds the result toast (§5.10).
    if (data.lessons) return ok(data);
    return ok(
      data,
      id
        ? msg("common.toast.saved")
        : msg("common.toast.created", { name: term.name }),
    );
  });
}

export async function deleteTermAction(id: string) {
  return runAdminAction(async (scope) => {
    const term = await deleteTerm(scope, id);
    revalidatePath(PATH);
    return ok(undefined, msg("common.toast.deleted", { name: term.name }));
  });
}

type SavedHoliday = { id: string; name: string; lessons: LessonResult };

/**
 * `touchesPublished` is what the dialog showed the admin; lesson counts are
 * reported whenever lessons actually changed or the admin was told they
 * would.
 */
function holidayLessons(
  lessons: LessonChanges,
  touchesPublished: boolean,
): LessonResult {
  const changed = lessons.created + lessons.removed + lessons.cancelled > 0;
  return changed || touchesPublished ? lessonChangeParts(lessons) : null;
}

export async function saveHolidayAction(
  id: string | null,
  touchesPublished: boolean,
  _previous: ActionResult<SavedHoliday> | null,
  formData: FormData,
): Promise<ActionResult<SavedHoliday>> {
  return runAdminAction(async (scope) => {
    const parsed = parseInput(holidaySchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const holiday = await saveHoliday(scope, id, parsed.data);
    revalidatePath(PATH);
    const data = {
      id: holiday.id,
      name: holiday.name,
      lessons: holidayLessons(holiday.lessons, touchesPublished),
    };
    if (data.lessons) return ok(data);
    return ok(
      data,
      id
        ? msg("common.toast.saved")
        : msg("common.toast.created", { name: holiday.name }),
    );
  });
}

export async function deleteHolidayAction(
  id: string,
  touchesPublished: boolean,
): Promise<ActionResult<{ name: string; lessons: LessonResult }>> {
  return runAdminAction(async (scope) => {
    const holiday = await deleteHoliday(scope, id);
    revalidatePath(PATH);
    const data = {
      name: holiday.name,
      lessons: holidayLessons(holiday.lessons, touchesPublished),
    };
    if (data.lessons) return ok(data);
    return ok(data, msg("common.toast.deleted", { name: holiday.name }));
  });
}
