"use client";

import { CircleAlert, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { useReasonText } from "@/components/absences/reason-text";
import { ToneAlert } from "@/components/absences/tone";
import { useMessage } from "@/components/admin/use-message";
import { formatMinutes, useDateFormat } from "@/components/timetable/format";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { Message } from "@/server/admin/result";
import type {
  AdminBookingOptions,
  OverrideOption,
  ReasonView,
} from "@/server/replacements/booking";
import { REVIEW_NOTE_MAX } from "@/server/replacements/schema";

import {
  bookReplacementForStudentAction,
  loadAdminBookingOptionsAction,
} from "./actions";
import { OptionRow } from "./review-client";

/**
 * Book replacement… (CARM-47, replacements.md §6 _Admin booking_): the
 * admin spends a student's AVAILABLE group credit on a lesson for them.
 * Lessons with overridable reasons show on "Show all lessons" and need each
 * reason ticked, as in Override.
 */
export function BookForStudentDialog({
  creditId,
  studentName,
  onClose,
}: {
  creditId: string;
  studentName: string;
  onClose: () => void;
}) {
  const t = useTranslations("adminAbsences");
  const tc = useTranslations("common");
  const formatDate = useDateFormat();
  const format = useFormatter();
  const render = useMessage();
  const reasonText = useReasonText();
  const router = useRouter();
  const noteId = useId();
  const noteHintId = useId();
  const [showAll, setShowAll] = useState(false);
  const [data, setData] = useState<AdminBookingOptions | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [fresh, setFresh] = useState<ReasonView[] | null>(null);
  const [error, setError] = useState<Message | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    loadAdminBookingOptionsAction(creditId, showAll)
      .then((result) => {
        if (!active) return;
        if (result.ok) setData(result.data);
        else setError(result.formError ?? { key: "common.error.unexpected" });
      })
      .catch(() => active && setError({ key: "common.error.network" }));
    return () => {
      active = false;
    };
  }, [creditId, showAll]);

  const chosen = data?.options.find((o) => o.id === choice) ?? null;
  const reasons = fresh ?? chosen?.reasons ?? [];
  const overridable = reasons.filter((r) => r.overridable);
  const isBlocked = reasons.some((r) => !r.overridable);
  const allAcknowledged = overridable.every((r) =>
    acknowledged.includes(r.key),
  );
  const label = (o: OverrideOption) =>
    t("lessonRef", {
      date: formatDate(o.date, "weekdayLong"),
      time: formatMinutes(o.startMinute),
      group: o.groupName,
    });

  function pick(id: string) {
    setChoice(id);
    setAcknowledged([]);
    setFresh(null);
  }

  function run() {
    if (!choice) return;
    setError(null);
    startTransition(async () => {
      const result = await bookReplacementForStudentAction({
        creditId,
        targetLessonId: choice,
        acknowledgedKeys: acknowledged,
        note,
      }).catch(() => null);
      if (!result) return setError({ key: "common.error.network" });
      if (!result.ok) {
        return setError(
          result.formError ??
            Object.values(result.fieldErrors ?? {})[0] ?? {
              key: "common.error.unexpected",
            },
        );
      }
      if (result.data.status === "refused") {
        // The lesson changed meanwhile: show its fresh reasons to tick.
        setFresh(result.data.reasons);
        setAcknowledged([]);
        return;
      }
      toast.success(
        t("book.done", {
          dateTime: format.dateTime(new Date(result.data.startsAt), {
            weekday: "short",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          }),
        }),
      );
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("book.title", { student: studentName })}</DialogTitle>
          <DialogDescription>
            {data &&
              t("book.description", {
                student: studentName,
                sourceDate: formatDate(data.credit.sourceDate, "dayMonth"),
                validUntil: formatDate(data.credit.validUntil, "weekdayDate"),
              })}
          </DialogDescription>
        </DialogHeader>
        {!data && !error && (
          <p className="text-sm text-muted-foreground">{t("book.loading")}</p>
        )}
        {data && (
          <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">{t("book.options")}</legend>
              <div className="flex items-center justify-between gap-2">
                <span aria-hidden="true" className="text-sm font-medium">
                  {t("book.options")}
                </span>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={showAll} onCheckedChange={setShowAll} />
                  {t("book.showAll")}
                </label>
              </div>
              {data.options.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("book.none")}
                </p>
              )}
              {data.options.map((o) => (
                <OptionRow
                  key={o.id}
                  value={o.id}
                  checked={choice === o.id}
                  onPick={() => pick(o.id)}
                  label={t("override.optionLabel", {
                    lesson: label(o),
                    room: o.roomName ?? t("noRoom"),
                    teacher: o.teacherName,
                  })}
                  reasons={o.reasons}
                />
              ))}
            </fieldset>
          </div>
        )}
        {isBlocked && (
          <ToneAlert tone="danger" icon={CircleAlert}>
            {t("book.blocked")}{" "}
            {reasons
              .filter((r) => !r.overridable)
              .map(reasonText)
              .join(", ")}
          </ToneAlert>
        )}
        {overridable.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {overridable.map((r) => (
              <li key={r.key} className="flex items-start gap-2">
                <Checkbox
                  id={`book-ack-${creditId}-${r.key}`}
                  checked={acknowledged.includes(r.key)}
                  onCheckedChange={(checked) =>
                    setAcknowledged((current) =>
                      checked
                        ? [...current, r.key]
                        : current.filter((k) => k !== r.key),
                    )
                  }
                />
                <Label
                  htmlFor={`book-ack-${creditId}-${r.key}`}
                  className="font-normal"
                >
                  {t("override.ack", { reason: reasonText(r) })}
                </Label>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor={noteId}>{t("book.note")}</Label>
          <Input
            id={noteId}
            value={note}
            maxLength={REVIEW_NOTE_MAX}
            placeholder={t("book.notePlaceholder")}
            aria-describedby={noteHintId}
            onChange={(event) => setNote(event.target.value)}
          />
          <p id={noteHintId} className="text-xs text-muted-foreground">
            {t("book.noteHint")}
          </p>
        </div>
        {error && (
          <ToneAlert tone="danger" icon={CircleAlert}>
            {render(error)}
          </ToneAlert>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button
            disabled={
              pending || !data || !choice || isBlocked || !allAcknowledged
            }
            onClick={run}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {t("book.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
