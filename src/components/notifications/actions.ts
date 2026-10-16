"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import { requireViewer } from "@/server/auth/session";
import { scopeToSchool } from "@/server/db/school-scope";
import {
  type InboxViewer,
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
} from "@/server/notifications/inbox";
import { INBOX_PAGE_SIZE, POPOVER_SIZE } from "@/server/notifications/rules";
import {
  type NotificationPageView,
  toPageView,
} from "@/server/notifications/view";

// Inbox actions (phase5-rules.md §2.7). Every signed-in member may call
// them; each re-reads the membership, validates its input and reads only
// the viewer's own rows through the school-scoped client.

async function context() {
  const viewer = await requireViewer();
  const inbox: InboxViewer = { userId: viewer.userId, role: viewer.role };
  return { viewer, inbox, db: scopeToSchool(db, viewer.school.id) };
}

const listInput = z.object({
  cursor: z.string().max(100).nullable().optional(),
  unreadOnly: z.boolean().optional(),
  popover: z.boolean().optional(),
});

/** One page of the viewer's notifications, with the unread count. */
export async function listNotificationsAction(
  input: z.input<typeof listInput>,
): Promise<NotificationPageView & { unread: number }> {
  const parsed = listInput.parse(input);
  const { viewer, inbox, db } = await context();
  const now = new Date();
  const page = await listNotifications(
    db,
    inbox,
    {
      cursor: parsed.cursor ?? null,
      unreadOnly: parsed.unreadOnly ?? false,
      limit: parsed.popover ? POPOVER_SIZE : INBOX_PAGE_SIZE,
    },
    now,
  );
  return {
    ...(await toPageView(viewer, page, now)),
    unread: await unreadCount(db, inbox, now),
  };
}

/**
 * Marks one notification read before the client navigates and returns
 * where it leads (null: gone, or not the viewer's notification).
 */
export async function markReadAction(
  id: string,
): Promise<{ ok: boolean; href: string | null }> {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, href: null };
  const { inbox, db } = await context();
  const result = await markRead(db, inbox, parsed.data, new Date());
  return result ? { ok: true, href: result.href } : { ok: false, href: null };
}

/** Marks read everything up to the newest item the client has shown. */
export async function markAllReadAction(
  upTo: string,
): Promise<{ ok: boolean; unread: number }> {
  const parsed = z.string().max(100).safeParse(upTo);
  const { inbox, db } = await context();
  const now = new Date();
  const count = parsed.success
    ? await markAllRead(db, inbox, parsed.data, now)
    : null;
  return { ok: count !== null, unread: await unreadCount(db, inbox, now) };
}
