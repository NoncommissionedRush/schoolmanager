"use server";

// Server actions of the timetable generator (docs/architecture/generator.md
// §7). Every action re-checks the admin role, goes through the
// school-scoped client and validates its input; the UI arrives in CARM-56.

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { runAdminAction } from "@/server/admin/context";
import { type ActionResult, msg, ok } from "@/server/admin/result";
import type { Readiness, TeacherOption } from "@/server/scheduling/generator";
import {
  applyDraftSchema,
  groupSkipSchema,
  idSchema,
  lockAssignmentsSchema,
  previewApplySchema,
  readinessSchema,
  saveAssignmentSchema,
  startRunSchema,
  teacherOptionsSchema,
} from "@/server/timetable/generator-schema";
import {
  type ApplyResult,
  applyDraft,
  cancelRun,
  checkDraft,
  checkReadiness,
  discardDraft,
  type DraftEditResult,
  type DraftView,
  executeRun,
  getDraft,
  getRun,
  type PreviewResult,
  previewApply,
  type RunView,
  saveAssignment,
  setAssignmentsLocked,
  setGroupSkipped,
  startRun,
  teacherOptions,
} from "@/server/timetable/generator-service";

const invalid = {
  ok: false as const,
  formError: msg("scheduling.errors.INVALID_INPUT"),
};

/** A malformed id can't match a record: refused like an unknown one. */
const notFound = {
  ok: false as const,
  formError: msg("scheduling.errors.NOT_FOUND"),
};

function revalidate() {
  revalidatePath("/admin/timetable", "layout");
  revalidatePath("/teacher/timetable");
  revalidatePath("/student/timetable");
}

export async function checkReadinessAction(
  input: unknown,
): Promise<ActionResult<Readiness>> {
  return runAdminAction(async ({ db }) => {
    const parsed = readinessSchema.safeParse(input);
    if (!parsed.success) return invalid;
    const { termId, ...options } = parsed.data;
    return ok(await checkReadiness(db, termId, options));
  });
}

export async function setGroupSkippedAction(
  input: unknown,
): Promise<ActionResult<undefined>> {
  return runAdminAction(async ({ db, actor }) => {
    const parsed = groupSkipSchema.safeParse(input);
    if (!parsed.success) return invalid;
    await setGroupSkipped(db, actor, parsed.data);
    return ok(undefined);
  });
}

/**
 * Starts a run and executes it after the response is sent (§4.6), so the
 * progress survives a reload and other admins see it.
 */
export async function startRunAction(
  input: unknown,
): Promise<ActionResult<{ runId: string; draftId: string }>> {
  return runAdminAction(async ({ db, actor }) => {
    const parsed = startRunSchema.safeParse(input);
    if (!parsed.success) return invalid;
    const started = await startRun(db, actor, parsed.data);
    after(async () => {
      try {
        await executeRun(db, started.runId);
      } catch (error) {
        // Already recorded on the run (FAILED, INTERNAL_ERROR).
        console.error("Generator run failed", started.runId, error);
      }
    });
    return ok(started);
  });
}

export async function getRunAction(
  runId: unknown,
): Promise<ActionResult<RunView>> {
  return runAdminAction(async ({ db }) => {
    const parsed = idSchema.safeParse(runId);
    if (!parsed.success) return notFound;
    return ok(await getRun(db, parsed.data));
  });
}

export async function cancelRunAction(
  runId: unknown,
): Promise<ActionResult<undefined>> {
  return runAdminAction(async ({ db }) => {
    const parsed = idSchema.safeParse(runId);
    if (!parsed.success) return notFound;
    await cancelRun(db, parsed.data);
    return ok(undefined);
  });
}

export async function getDraftAction(
  termId: unknown,
): Promise<ActionResult<DraftView | null>> {
  return runAdminAction(async ({ db }) => {
    const parsed = idSchema.safeParse(termId);
    if (!parsed.success) return notFound;
    return ok(await getDraft(db, parsed.data));
  });
}

export async function teacherOptionsAction(
  input: unknown,
): Promise<ActionResult<TeacherOption[]>> {
  return runAdminAction(async ({ db }) => {
    const parsed = teacherOptionsSchema.safeParse(input);
    if (!parsed.success) return invalid;
    return ok(await teacherOptions(db, parsed.data));
  });
}

export async function saveAssignmentAction(
  input: unknown,
): Promise<ActionResult<DraftEditResult>> {
  return runAdminAction(async ({ db }) => {
    const parsed = saveAssignmentSchema.safeParse(input);
    if (!parsed.success) return invalid;
    return ok(await saveAssignment(db, parsed.data));
  });
}

export async function setAssignmentsLockedAction(
  input: unknown,
): Promise<ActionResult<DraftEditResult>> {
  return runAdminAction(async ({ db }) => {
    const parsed = lockAssignmentsSchema.safeParse(input);
    if (!parsed.success) return invalid;
    return ok(await setAssignmentsLocked(db, parsed.data));
  });
}

export async function checkDraftAction(
  draftId: unknown,
): Promise<ActionResult<DraftView>> {
  return runAdminAction(async ({ db }) => {
    const parsed = idSchema.safeParse(draftId);
    if (!parsed.success) return notFound;
    return ok(await checkDraft(db, { draftId: parsed.data }));
  });
}

export async function previewApplyAction(
  input: unknown,
): Promise<ActionResult<PreviewResult>> {
  return runAdminAction(async ({ db, actor }) => {
    const parsed = previewApplySchema.safeParse(input);
    if (!parsed.success) return invalid;
    return ok(await previewApply(db, actor, parsed.data));
  });
}

export async function applyDraftAction(
  input: unknown,
): Promise<ActionResult<ApplyResult>> {
  return runAdminAction(async ({ db, actor }) => {
    const parsed = applyDraftSchema.safeParse(input);
    if (!parsed.success) return invalid;
    const result = await applyDraft(db, actor, parsed.data);
    if (result.ok) revalidate();
    return ok(result);
  });
}

export async function discardDraftAction(
  draftId: unknown,
): Promise<ActionResult<undefined>> {
  return runAdminAction(async ({ db, actor }) => {
    const parsed = idSchema.safeParse(draftId);
    if (!parsed.success) return notFound;
    await discardDraft(db, actor, parsed.data);
    return ok(undefined);
  });
}
