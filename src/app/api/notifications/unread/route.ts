import { connection } from "next/server";

import { db } from "@/lib/db";
import { getViewer } from "@/server/auth/session";
import { scopeToSchool } from "@/server/db/school-scope";
import { unreadCount } from "@/server/notifications/inbox";

/**
 * The bell's unread count, polled every 60 s while the tab is visible
 * (docs/design/notifications-substitutes.md §4.1). The viewer's own rows
 * only; signed out → 401.
 */
export async function GET() {
  await connection();
  const viewer = await getViewer();
  if (!viewer) return new Response(null, { status: 401 });
  const count = await unreadCount(
    scopeToSchool(db, viewer.school.id),
    { userId: viewer.userId, role: viewer.role },
    new Date(),
  );
  return Response.json(
    { count },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
