import { getTranslations } from "next-intl/server";

import { Skeleton } from "@/components/ui/skeleton";
import type { Role } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { requireRole } from "@/server/auth/session";
import { scopeToSchool } from "@/server/db/school-scope";
import { listNotifications, unreadCount } from "@/server/notifications/inbox";
import {
  INBOX_PAGE_SIZE,
  NOTIFICATION_RETENTION_DAYS,
} from "@/server/notifications/rules";
import { toPageView } from "@/server/notifications/view";

import { InboxClient } from "./inbox-client";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The notification inbox, the same page in every role's shell
 * (docs/design/notifications-substitutes.md §4.2): the viewer's own
 * notifications, 20 per page, All / Unread in the URL (`?filter=unread`).
 */
export async function InboxPage({
  role,
  searchParams,
}: {
  role: Role;
  searchParams: SearchParams;
}) {
  const viewer = await requireRole(role);
  const t = await getTranslations("notifications");
  const scoped = scopeToSchool(db, viewer.school.id);
  const inbox = { userId: viewer.userId, role: viewer.role };
  const unreadOnly = searchParams.filter === "unread";
  const now = new Date();
  const page = await listNotifications(
    scoped,
    inbox,
    { unreadOnly, limit: INBOX_PAGE_SIZE },
    now,
  );
  const [view, unread] = await Promise.all([
    toPageView(viewer, page, now),
    unreadCount(scoped, inbox, now),
  ]);
  const basePath = `/${role.toLowerCase()}/notifications`;
  return (
    <div
      className={
        role === "STUDENT"
          ? "mx-auto flex max-w-3xl flex-col gap-4 text-base"
          : "mx-auto flex max-w-3xl flex-col gap-4"
      }
    >
      <InboxClient
        key={`${unreadOnly}`}
        basePath={basePath}
        unreadOnly={unreadOnly}
        initial={view}
        initialUnread={unread}
      />
      <p className="text-center text-xs text-muted-foreground">
        {t("retention", { days: NOTIFICATION_RETENTION_DAYS })}
      </p>
    </div>
  );
}

export function InboxSkeleton() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-8 w-40" />
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  );
}
