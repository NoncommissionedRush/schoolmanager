"use server";

import { revalidatePath } from "next/cache";

import { runAdminAction } from "@/server/admin/context";
import { type ActionResult, msg, ok } from "@/server/admin/result";
import { roomSchema } from "@/server/admin/rooms/schema";
import {
  archiveRoom,
  capacityWarnings,
  createRoom,
  deleteRoom,
  restoreRoom,
  updateRoom,
} from "@/server/admin/rooms/service";
import { schoolToday } from "@/server/admin/shared";
import type { Message } from "@/server/admin/result";
import { formDataToObject, parseInput } from "@/server/admin/validation";

const PATH = "/admin/settings/rooms";

type Saved = { id: string; name: string; warnings: Message[] };

export async function saveRoomAction(
  id: string | null,
  _previous: ActionResult<Saved> | null,
  formData: FormData,
): Promise<ActionResult<Saved>> {
  return runAdminAction(async (scope) => {
    const { db, viewer } = scope;
    const parsed = parseInput(roomSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const room = id
      ? await updateRoom(scope, id, parsed.data)
      : await createRoom(scope, parsed.data);
    const warnings = id
      ? await capacityWarnings(
          db,
          id,
          parsed.data.capacity,
          schoolToday(viewer.school.timezone),
        )
      : [];
    revalidatePath(PATH);
    return ok(
      { ...room, warnings },
      id
        ? msg("common.toast.saved")
        : msg("common.toast.created", { name: room.name }),
    );
  });
}

export async function archiveRoomAction(id: string) {
  return runAdminAction(async (scope) => {
    await archiveRoom(scope, id);
    revalidatePath(PATH);
    // The client shows the toast with Undo (§5.3).
    return ok(undefined);
  });
}

export async function restoreRoomAction(id: string) {
  return runAdminAction(async (scope) => {
    const room = await restoreRoom(scope, id);
    revalidatePath(PATH);
    return ok(undefined, msg("common.toast.restored", { name: room.name }));
  });
}

export async function deleteRoomAction(id: string) {
  return runAdminAction(async (scope) => {
    const room = await deleteRoom(scope, id);
    revalidatePath(PATH);
    return ok(undefined, msg("common.toast.deleted", { name: room.name }));
  });
}
