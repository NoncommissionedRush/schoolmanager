"use server";

import { revalidatePath } from "next/cache";

import { runAdminAction } from "@/server/admin/context";
import { type ActionResult, msg, ok } from "@/server/admin/result";
import type { Conflict } from "@/server/scheduling";
import {
  deleteSlot,
  endSlot,
  type EndSlotResult,
  type LessonChanges,
  publishTerm,
  regenerateLessons,
  saveSlot,
  validateSlot,
} from "@/server/timetable/service";
import {
  endSlotSchema,
  idSchema,
  saveSlotSchema,
  slotRequestSchema,
} from "@/server/timetable/slot-schema";

const invalid = {
  ok: false as const,
  formError: msg("scheduling.errors.INVALID_INPUT"),
};

function revalidate() {
  revalidatePath("/admin/timetable", "layout");
  revalidatePath("/teacher/timetable");
  revalidatePath("/student/timetable");
}

/** Live check of a new or edited slot (timetable.md §5.4). */
export async function validateSlotAction(
  input: unknown,
): Promise<ActionResult<Conflict[]>> {
  return runAdminAction(async ({ db }) => {
    const parsed = slotRequestSchema.safeParse(input);
    if (!parsed.success) return invalid;
    return ok(await validateSlot(db, parsed.data));
  });
}

export type SaveSlotOutcome =
  | { saved: true; slotId: string; lessons: LessonChanges; published: boolean }
  | {
      saved: false;
      reason: "BLOCKING_CONFLICTS" | "UNACKNOWLEDGED_CONFLICTS";
      conflicts: Conflict[];
    };

/** Saves a slot with the admin's acknowledged warnings (override, audited). */
export async function saveSlotAction(
  input: unknown,
): Promise<ActionResult<SaveSlotOutcome>> {
  return runAdminAction(async ({ db, actor }) => {
    const parsed = saveSlotSchema.safeParse(input);
    if (!parsed.success) return invalid;
    const result = await saveSlot(db, actor, parsed.data);
    if (!result.ok) {
      return ok<SaveSlotOutcome>({
        saved: false,
        reason: result.reason,
        conflicts: result.conflicts,
      });
    }
    const term = await db.term.findUniqueOrThrow({
      where: { id: parsed.data.slot.termId },
      select: { timetablePublishedAt: true },
    });
    revalidate();
    return ok<SaveSlotOutcome>({
      saved: true,
      slotId: result.slotId,
      lessons: result.lessons,
      published: term.timetablePublishedAt !== null,
    });
  });
}

export async function endSlotAction(
  input: unknown,
): Promise<ActionResult<EndSlotResult>> {
  return runAdminAction(async ({ db, actor }) => {
    const parsed = endSlotSchema.safeParse(input);
    if (!parsed.success) return invalid;
    const result = await endSlot(db, actor, parsed.data);
    revalidate();
    return ok(result);
  });
}

export async function deleteSlotAction(
  slotId: unknown,
): Promise<ActionResult<LessonChanges>> {
  return runAdminAction(async ({ db, actor }) => {
    const parsed = idSchema.safeParse(slotId);
    if (!parsed.success) return invalid;
    const lessons = await deleteSlot(db, actor, parsed.data);
    revalidate();
    return ok(lessons);
  });
}

export type PublishOutcome =
  | { published: true; created: number }
  | { published: false; blockingSlotIds: string[]; conflicts: number };

export async function publishTermAction(
  termId: unknown,
): Promise<ActionResult<PublishOutcome>> {
  return runAdminAction(async ({ db, actor }) => {
    const parsed = idSchema.safeParse(termId);
    if (!parsed.success) return invalid;
    const result = await publishTerm(db, actor, parsed.data);
    if (!result.ok) {
      return ok<PublishOutcome>({
        published: false,
        blockingSlotIds: result.blocking.map((b) => b.slotId),
        conflicts: result.blocking.reduce((n, b) => n + b.conflicts.length, 0),
      });
    }
    revalidate();
    return ok<PublishOutcome>({
      published: true,
      created: result.lessons.created,
    });
  });
}

export async function regenerateLessonsAction(
  termId: unknown,
): Promise<ActionResult<LessonChanges>> {
  return runAdminAction(async ({ db, actor }) => {
    const parsed = idSchema.safeParse(termId);
    if (!parsed.success) return invalid;
    const lessons = await regenerateLessons(db, actor, parsed.data);
    revalidate();
    return ok(lessons);
  });
}
