"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { runAdminAction } from "@/server/admin/context";
import { CEFR_CODES, type MoveDirection } from "@/server/admin/levels/order";
import { levelSchema } from "@/server/admin/levels/schema";
import {
  addCefrPreset,
  archiveLevel,
  createLevel,
  deleteLevel,
  moveLevel,
  restoreLevel,
  updateLevel,
} from "@/server/admin/levels/service";
import { type ActionResult, msg, ok } from "@/server/admin/result";
import { assertIds, assertOptionalId } from "@/server/admin/shared";
import { formDataToObject, parseInput } from "@/server/admin/validation";

const PATH = "/admin/levels";

type Saved = { id: string; code: string };

export async function saveLevelAction(
  id: string | null,
  _previous: ActionResult<Saved> | null,
  formData: FormData,
): Promise<ActionResult<Saved>> {
  return runAdminAction(async (scope) => {
    assertOptionalId(id);
    const parsed = parseInput(levelSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const level = id
      ? await updateLevel(scope, id, parsed.data)
      : await createLevel(scope, parsed.data);
    revalidatePath(PATH);
    return ok(
      level,
      id
        ? msg("common.toast.saved")
        : msg("common.toast.created", { name: level.code }),
    );
  });
}

export async function moveLevelAction(id: string, direction: MoveDirection) {
  return runAdminAction(async (scope) => {
    assertIds(id);
    const level = await moveLevel(
      scope,
      id,
      direction === "up" ? "up" : "down",
    );
    revalidatePath(PATH);
    return ok(undefined, msg("levels.moved", { code: level.code }));
  });
}

export async function addCefrPresetAction() {
  return runAdminAction(async (scope) => {
    const t = await getTranslations("levels.preset");
    const names = Object.fromEntries(
      CEFR_CODES.map((code) => [code, t(code)]),
    ) as Record<(typeof CEFR_CODES)[number], string>;
    const count = await addCefrPreset(scope, names);
    revalidatePath(PATH);
    return ok(undefined, msg("levels.preset.added", { count }));
  });
}

export async function archiveLevelAction(id: string) {
  return runAdminAction(async (scope) => {
    assertIds(id);
    await archiveLevel(scope, id);
    revalidatePath(PATH);
    // The client shows the toast with Undo (§5.3).
    return ok(undefined);
  });
}

export async function restoreLevelAction(id: string) {
  return runAdminAction(async (scope) => {
    assertIds(id);
    const level = await restoreLevel(scope, id);
    revalidatePath(PATH);
    return ok(undefined, msg("common.toast.restored", { name: level.code }));
  });
}

export async function deleteLevelAction(id: string) {
  return runAdminAction(async (scope) => {
    assertIds(id);
    const level = await deleteLevel(scope, id);
    revalidatePath(PATH);
    return ok(undefined, msg("common.toast.deleted", { name: level.code }));
  });
}
