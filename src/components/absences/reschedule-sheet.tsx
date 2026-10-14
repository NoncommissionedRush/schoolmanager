"use client";

import {
  AlertTriangle,
  CalendarClock,
  CircleAlert,
  Loader2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  loadRescheduleSheetAction,
  rescheduleLessonAction,
} from "@/app/student/absences/actions";
import { useMessage } from "@/components/admin/use-message";
import { formatMinutes, useDateFormat } from "@/components/timetable/format";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import type { Message } from "@/server/admin/result";
import type { RescheduleSheet as SheetData } from "@/server/replacements/reschedule";

import { ToneAlert } from "./tone";

export type RescheduleSource = { lessonId: string } | { creditId: string };

/**
 * The student's Reschedule sheet for a 1-on-1 (absences.md §5.3): up to 20
 * free times with the same teacher, grouped by day, the usual time first.
 * The server picks the room and re-checks everything on save. "Cancel and
 * reschedule later" hands over to the cancel dialog (lesson source only).
 */
export function RescheduleSheet(props: RescheduleSheetProps) {
  // Remounting on open starts every visit with a fresh list.
  return <RescheduleSheetInner key={String(props.open)} {...props} />;
}

type RescheduleSheetProps = {
  source: RescheduleSource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCancelLater?: () => void;
};

function RescheduleSheetInner({
  source,
  open,
  onOpenChange,
  onCancelLater,
}: RescheduleSheetProps) {
  const t = useTranslations("reschedule");
  const tc = useTranslations("common");
  const format = useFormatter();
  const formatDate = useDateFormat();
  const render = useMessage();
  const router = useRouter();
  const mobile = useIsMobile();
  const summaryId = useId();
  const [data, setData] = useState<SheetData | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [taken, setTaken] = useState(false);
  const [pickError, setPickError] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [pending, startTransition] = useTransition();
  const sourceKey = "lessonId" in source ? source.lessonId : source.creditId;

  useEffect(() => {
    if (!open) return;
    let active = true;
    loadRescheduleSheetAction(source)
      .then((result) => {
        if (!active) return;
        if (result.ok) setData(result.data);
        else setError(result.formError ?? { key: "common.error.unexpected" });
      })
      .catch(() => active && setError({ key: "common.error.network" }));
    return () => {
      active = false;
    };
    // `source` is identified by its id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceKey]);

  const dateTime = (iso: string) =>
    format.dateTime(new Date(iso), {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  const option = data?.options.find((o) => o.startsAt === picked) ?? null;
  const days = data
    ? [...new Set(data.options.map((o) => o.date))].sort().map((date) => ({
        date,
        options: data.options.filter((o) => o.date === date),
      }))
    : [];

  function submit() {
    if (!picked) {
      setPickError(true);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await rescheduleLessonAction({
        ...source,
        startsAt: picked,
      }).catch(() => null);
      if (!result) {
        setError({ key: "common.error.network" });
        return;
      }
      if (!result.ok) {
        setError(result.formError ?? { key: "common.error.unexpected" });
        return;
      }
      if (result.data.status === "taken") {
        setData(result.data.sheet);
        setPicked(null);
        setTaken(true);
        return;
      }
      onOpenChange(false);
      toast.success(t("done", { dateTime: dateTime(result.data.startsAt) }));
      router.refresh();
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={mobile ? "bottom" : "right"}
        closeLabel={tc("close")}
        className={
          mobile
            ? "max-h-[95svh] rounded-t-xl text-base"
            : "text-base sm:max-w-md"
        }
      >
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>
            {data ? t("with", { teacher: data.teacherName }) : t("loading")}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
          {data?.current && (
            <p className={picked ? "line-through" : undefined}>
              {t("now", {
                dateTime: `${formatDate(data.current.date, "weekdayLong")}, ${formatMinutes(data.current.startMinute)}–${formatMinutes(data.current.endMinute)}`,
              })}
            </p>
          )}
          {data?.again && (
            <p className="text-sm text-muted-foreground">
              {t("again", {
                sourceDate: formatDate(data.sourceDate, "dayMonth"),
              })}
            </p>
          )}
          {taken && (
            <ToneAlert tone="warning" icon={AlertTriangle}>
              {t("taken")}
            </ToneAlert>
          )}
          {error && (
            <ToneAlert tone="danger" icon={CircleAlert}>
              {render(error)}
            </ToneAlert>
          )}
          {!data && !error && (
            <div className="flex flex-col gap-2" aria-busy="true">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          )}
          {data && data.options.length === 0 && (
            <ToneAlert tone="muted" icon={CalendarClock}>
              {t("emptyAll", {
                teacher: data.teacherName,
                date: formatDate(data.validUntil, "weekdayDate"),
              })}
            </ToneAlert>
          )}
          {data && data.options.length > 0 && (
            <>
              <h2 className="font-medium">
                {t("pick", { date: formatDate(data.validUntil, "dayMonth") })}
              </h2>
              {days.map((day) => (
                <fieldset key={day.date} className="flex flex-col gap-2">
                  <legend className="mb-2 font-semibold">
                    {formatDate(day.date, "weekdayLong")}
                  </legend>
                  <div className="flex flex-wrap gap-2">
                    {day.options.map((o) => (
                      <label key={o.startsAt} className="cursor-pointer">
                        <input
                          type="radio"
                          name="reschedule-time"
                          value={o.startsAt}
                          checked={picked === o.startsAt}
                          onChange={() => {
                            setPicked(o.startsAt);
                            setPickError(false);
                          }}
                          aria-label={format.dateTime(new Date(o.startsAt), {
                            weekday: "long",
                            day: "numeric",
                            month: "long",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          className="peer sr-only"
                        />
                        <span className="flex min-h-11 items-center gap-1 rounded-md border px-3 tabular-nums peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                          {formatMinutes(o.startMinute)}
                          {o.usual && (
                            <span className="text-xs">· {t("usualTime")}</span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </>
          )}
          <p id={summaryId} aria-live="polite" className="text-sm">
            {option
              ? option.roomName
                ? t("summary", {
                    dateTime: `${formatDate(option.date, "weekdayLong")}, ${formatMinutes(option.startMinute)}–${formatMinutes(option.endMinute)}`,
                    room: option.roomName,
                  })
                : t("summaryNoRoom", {
                    dateTime: `${formatDate(option.date, "weekdayLong")}, ${formatMinutes(option.startMinute)}–${formatMinutes(option.endMinute)}`,
                  })
              : null}
          </p>
          {pickError && (
            <p role="alert" className="text-sm text-danger">
              {t("pickRequired")}
            </p>
          )}
        </div>
        <SheetFooter className="flex-col gap-2">
          {data && data.options.length > 0 && (
            <Button
              size="lg"
              className="w-full"
              disabled={pending}
              aria-describedby={summaryId}
              onClick={submit}
            >
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {t("confirm")}
            </Button>
          )}
          {onCancelLater && (
            <div className="flex flex-col items-center gap-1 text-sm">
              <span className="text-muted-foreground">{t("laterPrompt")}</span>
              <Button
                variant={data?.options.length === 0 ? "default" : "link"}
                size="lg"
                disabled={pending}
                onClick={() => {
                  onOpenChange(false);
                  onCancelLater();
                }}
              >
                {t("later")}
              </Button>
            </div>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
