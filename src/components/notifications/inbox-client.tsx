"use client";

import { Bell, EllipsisVertical } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type {
  NotificationItem,
  NotificationPageView,
} from "@/server/notifications/view";

import {
  listNotificationsAction,
  markAllReadAction,
  markReadAction,
} from "./actions";
import { NotificationEntry } from "./notification-item";

const DAYS = ["today", "yesterday", "earlier"] as const;

/** The inbox list (§4.2): filter, day groups, row menu, Load more. */
export function InboxClient({
  basePath,
  unreadOnly,
  initial,
  initialUnread,
}: {
  basePath: string;
  unreadOnly: boolean;
  initial: NotificationPageView;
  initialUnread: number;
}) {
  const t = useTranslations("notifications");
  const router = useRouter();
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [unread, setUnread] = useState(initialUnread);
  const [loadError, setLoadError] = useState(false);
  const [markError, setMarkError] = useState(false);
  const [loading, startLoading] = useTransition();
  const [marking, startMarking] = useTransition();

  const markAll = () =>
    startMarking(async () => {
      setMarkError(false);
      const result = items[0] ? await markAllReadAction(items[0].cursor) : null;
      if (!result?.ok) {
        setMarkError(true);
        return;
      }
      setUnread(result.unread);
      setItems((list) =>
        unreadOnly ? [] : list.map((item) => ({ ...item, read: true })),
      );
      toast.success(t("markedAllRead"));
      router.refresh();
    });

  const markOne = (item: NotificationItem) =>
    startMarking(async () => {
      const result = await markReadAction(item.id);
      if (!result.ok) return;
      setUnread((n) => Math.max(0, n - 1));
      setItems((list) =>
        list.map((i) => (i.id === item.id ? { ...i, read: true } : i)),
      );
      router.refresh();
    });

  const loadMore = () =>
    startLoading(async () => {
      setLoadError(false);
      try {
        const page = await listNotificationsAction({ cursor, unreadOnly });
        setItems((list) => [...list, ...page.items]);
        setCursor(page.nextCursor);
        setUnread(page.unread);
      } catch {
        setLoadError(true);
      }
    });

  const filterLink = (value: "all" | "unread", label: string) => {
    const active = (value === "unread") === unreadOnly;
    return (
      <Link
        href={value === "unread" ? `${basePath}?filter=unread` : basePath}
        aria-current={active ? "page" : undefined}
        className={cn(
          "rounded-md px-3 py-1.5 text-sm font-medium",
          active
            ? "bg-background shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {label}
      </Link>
    );
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        {unread > 0 && items.length > 0 && (
          <Button variant="outline" disabled={marking} onClick={markAll}>
            {t("markAllRead")}
          </Button>
        )}
      </div>
      <nav
        aria-label={t("filter.label")}
        className="flex w-fit gap-1 rounded-lg bg-muted p-1"
      >
        {filterLink("all", t("filter.all"))}
        {filterLink("unread", t("filter.unread", { count: unread }))}
      </nav>
      {markError && (
        <Alert variant="destructive">
          <AlertDescription>{t("error.markAll")}</AlertDescription>
        </Alert>
      )}

      {items.length === 0 ? (
        unreadOnly ? (
          <EmptyState icon={Bell} title={t("empty.unread")}>
            <Link
              href={basePath}
              className={buttonVariants({ variant: "link" })}
            >
              {t("empty.showAll")}
            </Link>
          </EmptyState>
        ) : (
          <EmptyState
            icon={Bell}
            title={t("empty.title")}
            description={t("empty.description")}
          />
        )
      ) : (
        DAYS.map((day) => {
          const group = items.filter((item) => item.day === day);
          if (group.length === 0) return null;
          return (
            <section key={day} className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold text-muted-foreground">
                {t(`group.${day}`)}
              </h2>
              <ul className="flex flex-col gap-2">
                {group.map((item) => (
                  <li key={item.id}>
                    <Card className="py-1">
                      <NotificationEntry
                        item={item}
                        menu={
                          item.read ? null : (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="mt-1.5 mr-1"
                                    aria-label={t("rowMenu")}
                                  />
                                }
                              >
                                <EllipsisVertical aria-hidden="true" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => markOne(item)}>
                                  {t("markRead")}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )
                        }
                      />
                    </Card>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-2">
            {t("error.load")}
            <Button variant="outline" size="sm" onClick={loadMore}>
              {t("error.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {cursor && !loadError && (
        <Button
          variant="outline"
          className="self-center"
          disabled={loading}
          onClick={loadMore}
        >
          {t("loadMore")}
        </Button>
      )}
    </>
  );
}
