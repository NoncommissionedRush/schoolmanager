"use server";

import { revalidatePath } from "next/cache";

import { runAdminAction } from "@/server/admin/context";
import { type ActionResult, ok } from "@/server/admin/result";
import { parseInput } from "@/server/admin/validation";
import { setRatingHidden } from "@/server/ratings/admin-data";
import {
  type HideRatingInput,
  hideRatingSchema,
} from "@/server/ratings/schema";

/** Hide or unhide a rating (phase5-rules.md §4.2). Admin only. */
export async function setRatingHiddenAction(
  input: HideRatingInput,
): Promise<ActionResult<{ changed: boolean }>> {
  return runAdminAction(async ({ db, actor }) => {
    const parsed = parseInput(hideRatingSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const changed = await setRatingHidden(db, actor, parsed.data, new Date());
    revalidatePath("/admin/ratings", "layout");
    return ok({ changed });
  });
}
