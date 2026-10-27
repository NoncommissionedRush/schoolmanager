"use server";

import { revalidatePath } from "next/cache";

import {
  exceptionSchema,
  weeklySchema,
} from "@/server/admin/availability/schema";
import { type ActionResult, msg, ok } from "@/server/admin/result";
import { assertIds, assertOptionalId, notFound } from "@/server/admin/shared";
import { formDataToObject, parseInput } from "@/server/admin/validation";
import {
  requestDelete,
  requestException,
  requestWeekly,
  withdrawRequest,
} from "@/server/availability-requests/service";
import {
  runTeacherAction,
  type TeacherContext,
} from "@/server/lessons/context";

// The teacher's availability page (availability-requests.md §3). Every
// action re-checks the TEACHER role and works on the signed-in teacher's own
// profile only; nothing reaches `TeacherAvailability` until an admin approves.

function scopeOf({ db, schoolId, viewer, teacherId }: TeacherContext) {
  if (!teacherId) throw notFound();
  return {
    scope: { db, schoolId, actor: { userId: viewer.userId } },
    teacherId,
  };
}

function revalidate(teacherId: string) {
  revalidatePath("/teacher/availability");
  revalidatePath(`/admin/teachers/${teacherId}`);
  revalidatePath("/admin/teachers");
}

const sent = () => msg("availabilityRequests.toast.sent");

export async function requestWeeklyAction(
  replaceId: string | null,
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return runTeacherAction(async (context) => {
    assertOptionalId(replaceId);
    const { scope, teacherId } = scopeOf(context);
    const parsed = parseInput(weeklySchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    await requestWeekly(scope, teacherId, parsed.data, replaceId, new Date());
    revalidate(teacherId);
    return ok(undefined, sent());
  });
}

export async function requestExceptionAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<{ affected: number }>> {
  return runTeacherAction(async (context) => {
    const { scope, teacherId } = scopeOf(context);
    const parsed = parseInput(exceptionSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    await requestException(
      scope,
      teacherId,
      parsed.data,
      context.viewer.school.timezone,
      new Date(),
    );
    revalidate(teacherId);
    return ok({ affected: 0 }, sent());
  });
}

export async function requestDeleteAction(ruleId: string) {
  return runTeacherAction(async (context) => {
    assertIds(ruleId);
    const { scope, teacherId } = scopeOf(context);
    await requestDelete(scope, teacherId, ruleId, new Date());
    revalidate(teacherId);
    return ok(undefined, sent());
  });
}

export async function withdrawRequestAction(requestId: string) {
  return runTeacherAction(async (context) => {
    assertIds(requestId);
    const { scope, teacherId } = scopeOf(context);
    await withdrawRequest(scope, teacherId, requestId);
    revalidate(teacherId);
    return ok(undefined, msg("availabilityRequests.toast.withdrawn"));
  });
}
