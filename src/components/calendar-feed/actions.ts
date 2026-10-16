"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { requireRole } from "@/server/auth/session";
import { createMyFeed, resetMyFeed } from "@/server/calendar-feed/service";
import { scopeToSchool } from "@/server/db/school-scope";

// Calendar link actions (phase5-rules.md §5.1) for the signed-in teacher or
// student; admins get 403. Each acts on the viewer's own link only.

async function run(action: typeof createMyFeed): Promise<{ ok: boolean }> {
  const viewer = await requireRole("TEACHER", "STUDENT");
  try {
    await action(
      scopeToSchool(db, viewer.school.id),
      { userId: viewer.userId, role: viewer.role },
      new Date(),
    );
  } catch (error) {
    console.error("calendar link action failed", error);
    return { ok: false };
  }
  revalidatePath(
    `/${viewer.role === "TEACHER" ? "teacher" : "student"}/calendar`,
  );
  return { ok: true };
}

/** _Create my calendar link_. */
export async function createCalendarFeedAction() {
  return run(createMyFeed);
}

/** _Reset link_: the old link stops working at once. */
export async function resetCalendarFeedAction() {
  return run(resetMyFeed);
}
