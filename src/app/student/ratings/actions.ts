"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import {
  type ActionResult,
  AdminError,
  ok,
  toFailure,
} from "@/server/admin/result";
import { parseInput } from "@/server/admin/validation";
import { requireRole } from "@/server/auth/session";
import { scopeToSchool } from "@/server/db/school-scope";
import {
  type SaveRatingInput,
  saveRatingSchema,
} from "@/server/ratings/schema";
import { type SaveRatingResult, saveRating } from "@/server/ratings/student";

/**
 * Saves the signed-in student's rating of a teacher (phase5-rules.md §4.2).
 * The service re-checks `canRate`; a teacher or term the student can't rate
 * is "not found".
 */
export async function saveRatingAction(
  input: SaveRatingInput,
): Promise<ActionResult<SaveRatingResult>> {
  const viewer = await requireRole("STUDENT");
  const parsed = parseInput(saveRatingSchema, input);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
  try {
    const result = await saveRating(
      scopeToSchool(db, viewer.school.id),
      viewer.userId,
      parsed.data,
      new Date(),
      viewer.school.timezone,
    );
    revalidatePath("/student/ratings");
    revalidatePath("/student");
    return ok(result);
  } catch (error) {
    if (error instanceof AdminError) return toFailure(error);
    throw error;
  }
}
