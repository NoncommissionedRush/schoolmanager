"use server";

import { revalidatePath } from "next/cache";

import { runAdminAction } from "@/server/admin/context";
import { type ActionResult, ok } from "@/server/admin/result";
import { assertIds } from "@/server/admin/shared";
import { revokeFeedAsAdmin } from "@/server/calendar-feed/service";

/**
 * _Turn off calendar link_ (phase5-rules.md §5.1): revokes a teacher's or
 * student's active link without creating or showing a new one; the user is
 * notified. Admin only.
 */
export async function revokeCalendarFeedAction(
  userId: string,
): Promise<ActionResult<{ revoked: boolean }>> {
  return runAdminAction(async ({ db, actor }) => {
    assertIds(userId);
    const revoked = await revokeFeedAsAdmin(
      db,
      actor,
      String(userId),
      new Date(),
    );
    revalidatePath("/admin/teachers", "layout");
    revalidatePath("/admin/students", "layout");
    return ok({ revoked });
  });
}
