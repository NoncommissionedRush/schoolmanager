"use client";

import { AlertTriangle, Ban, CircleAlert, Loader2, Ticket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useNow, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { cancelBookingAction } from "@/app/student/absences/actions";
import { useMessage } from "@/components/admin/use-message";
import { formatMinutes, useDateFormat } from "@/components/timetable/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Message } from "@/server/admin/result";

import { ToneAlert } from "./tone";

export type CancellableBooking = {
  bookingId: string;
  groupName: string;
  date: string;
  startMinute: number;
  endMinute: number;
  startsAt: string;
  /** Last instant cancelling gives the credit back. */
  cutoffAt: string;
  credit: { sourceDate: string; validUntil: string; expired: boolean } | null;
};

/**
 * Cancel a replacement booking (absences.md §5.7): before its cutoff the
 * credit comes back, after it the credit is used up (decision 9). The
 * server decides; this only previews it.
 */
export function CancelBookingDialog({
  booking,
  open,
  onOpenChange,
}: {
  booking: CancellableBooking;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("bookings");
  const tc = useTranslations("common");
  const formatDate = useDateFormat();
  const render = useMessage();
  const router = useRouter();
  const now = useNow({ updateInterval: 30_000 });
  const resultRef = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [pending, startTransition] = useTransition();

  const beforeCutoff = now.getTime() <= new Date(booking.cutoffAt).getTime();
  const expired = booking.credit?.expired === true;

  useEffect(() => {
    if (started || error) resultRef.current?.focus();
  }, [started, error]);

  function close(next: boolean) {
    if (!next) {
      setStarted(false);
      setError(null);
    }
    onOpenChange(next);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await cancelBookingAction({
        bookingId: booking.bookingId,
      }).catch(() => null);
      if (!result) {
        setError({ key: "common.error.network" });
        return;
      }
      if (!result.ok) {
        // A booking that started meanwhile is no longer theirs to cancel.
        if (new Date(booking.startsAt).getTime() <= Date.now()) {
          setStarted(true);
        } else {
          setError(result.formError ?? { key: "common.error.unexpected" });
        }
        return;
      }
      close(false);
      toast.success(
        result.data.creditBack ? t("cancel.doneBack") : t("cancel.done"),
      );
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("cancel.title", {
              group: booking.groupName,
              date: formatDate(booking.date, "weekdayLong"),
            })}
          </DialogTitle>
          <DialogDescription className="tabular-nums">
            {formatMinutes(booking.startMinute)}–
            {formatMinutes(booking.endMinute)}
          </DialogDescription>
        </DialogHeader>
        <div ref={resultRef} tabIndex={-1} className="outline-none">
          {started ? (
            <ToneAlert tone="danger" icon={Ban}>
              {t("cancel.started")}
            </ToneAlert>
          ) : !beforeCutoff ? (
            <ToneAlert tone="warning" icon={AlertTriangle} live>
              {t("cancel.creditLost")}{" "}
              <span className="mt-1 block">{t("cancel.lateNotice")}</span>
            </ToneAlert>
          ) : booking.credit && expired ? (
            <ToneAlert tone="warning" icon={AlertTriangle} live>
              {t("cancel.creditExpired", {
                date: formatDate(booking.credit.validUntil, "weekdayDate"),
              })}
            </ToneAlert>
          ) : booking.credit ? (
            <ToneAlert tone="success" icon={Ticket} live>
              {t("cancel.creditBack", {
                sourceDate: formatDate(booking.credit.sourceDate, "dayMonth"),
                expiry: formatDate(booking.credit.validUntil, "weekdayDate"),
              })}
            </ToneAlert>
          ) : null}
          {error && (
            <ToneAlert tone="danger" icon={CircleAlert} className="mt-3">
              {render(error)}
            </ToneAlert>
          )}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          {!started && (
            <Button
              size="lg"
              className="w-full"
              disabled={pending}
              onClick={submit}
            >
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {beforeCutoff ? t("cancelBooking") : t("cancelAnyway")}
            </Button>
          )}
          <Button
            size="lg"
            variant="outline"
            className="w-full"
            disabled={pending}
            onClick={() => close(false)}
          >
            {started ? tc("close") : t("keep")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
