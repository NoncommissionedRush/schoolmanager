"use client";

import {
  AlertTriangle,
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  Info,
  Loader2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { ToneAlert } from "@/components/absences/tone";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { createCalendarFeedAction, resetCalendarFeedAction } from "./actions";

/** `https://…` → `webcal://…` (opens Apple Calendar / Outlook directly). */
const webcal = (url: string) => url.replace(/^https?:\/\//, "webcal://");

/**
 * The calendar link card (notifications-substitutes.md §7.3–§7.5): create,
 * copy, subscribe and reset. The link only exists once created on request.
 */
export function CalendarFeedCard({
  link,
  revokedByAdmin,
}: {
  link: { url: string; createdOn: string } | null;
  revokedByAdmin: boolean;
}) {
  const t = useTranslations("calendarFeed");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<"create" | "reset" | null>(null);
  const [resetDone, setResetDone] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // After a reset the new link is shown and focused (§7.4).
  useEffect(() => {
    if (resetDone) field.current?.focus();
  }, [resetDone, link?.url]);

  const create = () =>
    startTransition(async () => {
      setError(null);
      const result = await createCalendarFeedAction();
      if (!result.ok) return setError("create");
      router.refresh();
    });

  const reset = () =>
    startTransition(async () => {
      setError(null);
      const result = await resetCalendarFeedAction();
      setConfirmOpen(false);
      if (!result.ok) return setError("reset");
      toast.success(t("reset.done"));
      setResetDone(true);
      router.refresh();
    });

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setCopyFallback(false);
    } catch {
      field.current?.select();
      setCopyFallback(true);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("link")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <ToneAlert tone="danger" icon={CircleAlert}>
            {t(`error.${error}`)}
          </ToneAlert>
        )}
        {!link ? (
          <>
            {revokedByAdmin && (
              <ToneAlert tone="info" icon={Info}>
                {t("revokedByAdmin")}
              </ToneAlert>
            )}
            <Button
              size="lg"
              className="self-start max-sm:w-full"
              disabled={pending}
              onClick={create}
            >
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {pending ? t("creating") : t("create")}
            </Button>
          </>
        ) : (
          <>
            {resetDone && (
              <ToneAlert tone="success" icon={CircleCheck} live>
                {t("reset.addNew")}
              </ToneAlert>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                ref={field}
                readOnly
                value={link.url}
                aria-label={t("link")}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-sm"
                data-testid="calendar-link"
              />
              <Button variant="outline" onClick={copy} className="shrink-0">
                {copied ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
                {copied ? t("copied") : t("copy")}
              </Button>
            </div>
            <p role="status" className="text-sm text-muted-foreground">
              {copied
                ? t("copiedStatus")
                : copyFallback
                  ? t("copyFallback")
                  : ""}
            </p>
            <a
              href={webcal(link.url)}
              className={buttonVariants({
                variant: "secondary",
                className: "self-start max-sm:w-full",
              })}
            >
              {t("subscribe")}
            </a>
            <ToneAlert tone="warning" icon={AlertTriangle}>
              {t("secret")}
            </ToneAlert>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                {t("createdOn", { date: link.createdOn })}
              </span>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => setConfirmOpen(true)}
              >
                {pending && (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                )}
                {pending ? t("resetting") : t("resetLink")}
              </Button>
            </div>
          </>
        )}
      </CardContent>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("reset.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("reset.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("reset.keep")}</AlertDialogCancel>
            <Button variant="destructive" disabled={pending} onClick={reset}>
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {pending ? t("resetting") : t("reset.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
