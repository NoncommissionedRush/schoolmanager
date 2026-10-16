import "server-only";

import { getSchoolFormatter } from "@/i18n/school-format";
import type { Message } from "@/server/admin/result";
import type { Viewer } from "@/server/auth/access";
import { addDays, toZonedDateTime } from "@/server/scheduling";

import {
  describeNotification,
  type NotificationFormat,
  type NotificationIcon,
  openLabel,
} from "./describe";
import { encodeCursor, type InboxPage, type InboxRow } from "./inbox";

/** One notification as the bell popover and the inbox page show it. */
export type NotificationItem = {
  id: string;
  /** Keyset position; "mark all as read" sends the newest one shown. */
  cursor: string;
  /** ISO instant, for the relative time and `<time datetime>`. */
  createdAt: string;
  read: boolean;
  /** Null: the target is gone or no longer readable ("No longer available"). */
  href: string | null;
  icon: NotificationIcon;
  title: Message;
  details: Message[];
  /** "Open lesson ›" etc.; null without a link. */
  open: Message | null;
  /** Inbox heading, in the school's time zone (§4.2). */
  day: "today" | "yesterday" | "earlier";
};

export type NotificationPageView = {
  items: NotificationItem[];
  nextCursor: string | null;
};

/** Renders stored rows for the viewer, in the school's time zone. */
export async function toItems(
  viewer: Viewer,
  rows: readonly InboxRow[],
  now: Date,
): Promise<NotificationItem[]> {
  const formatter = await getSchoolFormatter(viewer.school);
  const format: NotificationFormat = {
    date: (instant) =>
      formatter.dateTime(new Date(instant), {
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
    time: (instant) =>
      formatter.dateTime(new Date(instant), {
        hour: "2-digit",
        minute: "2-digit",
      }),
    day: (isoDate) =>
      formatter.dateTime(new Date(`${isoDate}T00:00:00Z`), {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }),
  };
  const today = toZonedDateTime(now, viewer.school.timezone).date;
  const yesterday = addDays(today, -1);
  return rows.map((row) => {
    const text = describeNotification(row, format);
    const date = toZonedDateTime(row.createdAt, viewer.school.timezone).date;
    return {
      id: row.id,
      cursor: encodeCursor(row),
      createdAt: row.createdAt.toISOString(),
      read: row.readAt !== null,
      href: row.href,
      icon: text.icon,
      title: text.title,
      details: text.details,
      open: row.href && row.link ? openLabel(row.link) : null,
      day:
        date === today ? "today" : date === yesterday ? "yesterday" : "earlier",
    };
  });
}

export async function toPageView(
  viewer: Viewer,
  page: InboxPage,
  now: Date,
): Promise<NotificationPageView> {
  return {
    items: await toItems(viewer, page.items, now),
    nextCursor: page.nextCursor,
  };
}
