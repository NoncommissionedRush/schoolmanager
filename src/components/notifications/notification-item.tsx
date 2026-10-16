"use client";

import {
  Ban,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarX,
  ChevronRight,
  DoorOpen,
  Link2,
  type LucideIcon,
  Repeat,
  UserRoundCog,
  UserRoundX,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition, type ReactNode } from "react";

import { useMessage } from "@/components/admin/use-message";
import { cn } from "@/lib/utils";
import type { NotificationIcon } from "@/server/notifications/describe";
import type { NotificationItem } from "@/server/notifications/view";

import { markReadAction } from "./actions";

const ICONS: Record<NotificationIcon, { icon: LucideIcon; tone: string }> = {
  ban: { icon: Ban, tone: "text-danger" },
  "calendar-clock": { icon: CalendarClock, tone: "text-info" },
  "door-open": { icon: DoorOpen, tone: "text-info" },
  "user-round-cog": { icon: UserRoundCog, tone: "text-lesson-substitute-text" },
  "user-round-x": { icon: UserRoundX, tone: "text-lesson-substitute-text" },
  "calendar-x": { icon: CalendarX, tone: "text-warning" },
  repeat: { icon: Repeat, tone: "text-warning" },
  "calendar-check": { icon: CalendarCheck, tone: "text-success" },
  "calendar-days": { icon: CalendarDays, tone: "text-info" },
  link: { icon: Link2, tone: "text-info" },
};

/**
 * Fired on `window` after a notification was marked read, so the header
 * bell re-reads its count (the layout isn't re-rendered on navigation).
 */
export const NOTIFICATIONS_CHANGED = "notifications-changed";

export function announceNotificationsChanged() {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
}

/** "5 min ago", "Yesterday", with the full date in `title` (§4.3). */
export function RelativeTime({ iso }: { iso: string }) {
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const date = new Date(iso);
  return (
    <time
      dateTime={iso}
      title={format.dateTime(date, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })}
    >
      {format.relativeTime(date, { now, style: "short" })}
    </time>
  );
}

/**
 * One notification (§4.3): unread dot + semibold title + hidden "Unread",
 * icon, title, detail line, relative time. The whole card is one link that
 * marks the item read on the server before navigating; without a target
 * it isn't a link and says "No longer available."
 */
export function NotificationEntry({
  item,
  compact = false,
  onOpened,
  menu,
}: {
  item: NotificationItem;
  compact?: boolean;
  /** Called after the item was marked read (e.g. to close the popover). */
  onOpened?: (id: string) => void;
  /** Row menu, rendered next to the link (inbox only). */
  menu?: ReactNode;
}) {
  const t = useTranslations("notifications");
  const render = useMessage();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { icon: Icon, tone } = ICONS[item.icon];

  const body = (
    <>
      <span className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "mt-2 size-2 shrink-0 rounded-full",
            item.read ? "bg-transparent" : "bg-primary",
          )}
        />
        <Icon
          aria-hidden="true"
          className={cn("mt-0.5 size-5 shrink-0", tone)}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "break-words",
              item.read ? "font-normal" : "font-semibold",
            )}
          >
            {!item.read && <span className="sr-only">{t("unreadLabel")}</span>}
            {render(item.title)}
          </span>
          {item.details.length > 0 && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {item.details.map(render).join(" · ")}
            </span>
          )}
          <span className="flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted-foreground">
            <RelativeTime iso={item.createdAt} />
            {item.href && item.open && !compact && (
              <span className="flex items-center gap-0.5 font-medium text-primary">
                {render(item.open)}
                <ChevronRight aria-hidden="true" className="size-3.5" />
              </span>
            )}
            {!item.href && <span>{t("gone")}</span>}
          </span>
        </span>
      </span>
    </>
  );

  const className = cn(
    "block w-full rounded-lg px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
    item.href && "hover:bg-muted",
    pending && "opacity-60",
  );

  return (
    <div
      className="flex items-start gap-1"
      data-testid="notification"
      data-read={item.read}
    >
      {item.href ? (
        <a
          href={item.href}
          className={className}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            startTransition(async () => {
              const result = await markReadAction(item.id);
              announceNotificationsChanged();
              onOpened?.(item.id);
              router.push(result.href ?? item.href!);
            });
          }}
        >
          {body}
        </a>
      ) : (
        <div className={className}>{body}</div>
      )}
      {menu}
    </div>
  );
}
