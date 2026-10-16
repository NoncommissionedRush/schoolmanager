"use client";

import { Bell, BellOff } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { NotificationItem } from "@/server/notifications/view";

import { listNotificationsAction, markAllReadAction } from "./actions";
import { NOTIFICATIONS_CHANGED, NotificationEntry } from "./notification-item";

const POLL_MS = 60_000;

/** "9+" above nine (§4.1). */
const badgeText = (count: number) => (count > 9 ? "9+" : String(count));

/**
 * Header bell with the unread badge (docs/design/notifications-substitutes.md
 * §4.1). The count comes with the page and is refreshed every 60 s while
 * the tab is visible and when the window regains focus. Desktop opens a
 * popover with the 8 newest; mobile goes straight to the inbox page.
 */
export function NotificationBell({
  initialCount,
  inboxHref,
}: {
  initialCount: number;
  inboxHref: string;
}) {
  const t = useTranslations("notifications");
  const isMobile = useIsMobile();
  const [count, setCount] = useState(initialCount);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const response = await fetch("/api/notifications/unread", {
        cache: "no-store",
      });
      if (response.ok)
        setCount(((await response.json()) as { count: number }).count);
    } catch {
      // Offline: keep the last count.
    }
  }, []);

  // A server refresh brings a new count with the page.
  const [seenInitial, setSeenInitial] = useState(initialCount);
  if (seenInitial !== initialCount) {
    setSeenInitial(initialCount);
    setCount(initialCount);
  }
  useEffect(() => {
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refresh]);

  const label = t("bell.label", { count });
  const icon = (
    <>
      <Bell aria-hidden="true" className="size-5" />
      {count > 0 && (
        <span
          aria-hidden="true"
          data-testid="notification-badge"
          className="absolute -top-0.5 -right-0.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-red-600 px-1 text-xs leading-none font-medium text-white tabular-nums"
        >
          {badgeText(count)}
        </span>
      )}
    </>
  );
  const buttonClass = "relative size-10 md:size-10 max-md:size-11";

  if (isMobile) {
    return (
      <Link
        href={inboxHref}
        aria-label={label}
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon" }),
          buttonClass,
        )}
      >
        {icon}
      </Link>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            title={label}
            className={buttonClass}
          />
        }
      >
        {icon}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] gap-0 p-0 shadow-lg">
        {open && (
          <PopoverBody
            inboxHref={inboxHref}
            onCount={setCount}
            onClose={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function PopoverBody({
  inboxHref,
  onCount,
  onClose,
}: {
  inboxHref: string;
  onCount: (count: number) => void;
  onClose: () => void;
}) {
  const t = useTranslations("notifications");
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; items: NotificationItem[]; unread: number }
  >({ status: "loading" });
  const [marking, startMarking] = useTransition();

  const load = useCallback(async () => {
    try {
      const page = await listNotificationsAction({ popover: true });
      setState({ status: "ready", items: page.items, unread: page.unread });
      onCount(page.unread);
    } catch {
      setState({ status: "error" });
    }
  }, [onCount]);
  const retry = () => {
    setState({ status: "loading" });
    void load();
  };

  useEffect(() => {
    // Fetching on open is the external system this syncs with.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const unreadShown =
    state.status === "ready" && state.items.some((item) => !item.read);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="font-semibold">{t("title")}</h2>
        {state.status === "ready" && unreadShown && (
          <Button
            variant="link"
            size="sm"
            disabled={marking}
            onClick={() =>
              startMarking(async () => {
                const result = await markAllReadAction(state.items[0].cursor);
                if (result.ok) {
                  onCount(result.unread);
                  setState({
                    ...state,
                    items: state.items.map((item) => ({ ...item, read: true })),
                  });
                }
              })
            }
          >
            {t("markAllRead")}
          </Button>
        )}
      </div>
      <div className="max-h-[60vh] overflow-y-auto p-1">
        {state.status === "loading" && (
          <div className="flex flex-col gap-2 p-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}
        {state.status === "error" && (
          <Alert variant="destructive" className="m-2 w-auto">
            <AlertDescription className="flex flex-col items-start gap-2">
              {t("error.load")}
              <Button variant="outline" size="sm" onClick={retry}>
                {t("error.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {state.status === "ready" && state.items.length === 0 && (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
            <BellOff
              aria-hidden="true"
              className="size-8 text-muted-foreground"
            />
            <p className="font-medium">{t("empty.unread")}</p>
            <p className="text-sm text-muted-foreground">
              {t("empty.popover")}
            </p>
          </div>
        )}
        {state.status === "ready" && state.items.length > 0 && (
          <ul className="flex flex-col">
            {state.items.map((item) => (
              <li key={item.id}>
                <NotificationEntry item={item} compact onOpened={onClose} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t p-1 text-center">
        <Link
          href={inboxHref}
          onClick={onClose}
          className={cn(buttonVariants({ variant: "ghost" }), "w-full")}
        >
          {t("seeAll")}
        </Link>
      </div>
    </div>
  );
}
