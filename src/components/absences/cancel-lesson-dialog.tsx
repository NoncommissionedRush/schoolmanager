"use client";

import { AlertTriangle, Ban, CircleAlert, Loader2, Ticket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useNow, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { cancelLessonAction } from "@/app/student/absences/actions";
import { useMessage } from "@/components/admin/use-message";
import { CharCounter } from "@/components/lessons/char-counter";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Message } from "@/server/admin/result";
import { ABSENCE_REASON_MAX } from "@/server/replacements/schema";
import type { StudentAttendance } from "@/server/timetable/week";

import { ToneAlert } from "./tone";

export type CancellableLesson = {
  id: string;
  groupName: string;
  level: string;
  oneOnOne: boolean;
  teacherName: string;
  date: string;
  startMinute: number;
  endMinute: number;
  attendance: StudentAttendance;
};

/**
 * The student's cancel dialog (absences.md §5.2): one screen that says,
 * before confirming, whether a makeup credit comes with it. The server
 * re-checks the cutoff; if it passed while the dialog was open, nothing is
 * saved and the dialog switches to the no-credit state.
 */
export function CancelLessonDialog({
  lesson,
  open,
  onOpenChange,
}: {
  lesson: CancellableLesson;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("absences");
  const tc = useTranslations("common");
  const formatDate = useDateFormat();
  const render = useMessage();
  const router = useRouter();
  const now = useNow({ updateInterval: 30_000 });
  const reasonId = useId();
  const hintId = useId();
  const counterId = useId();
  const resultRef = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState("");
  const [cutoffPassed, setCutoffPassed] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [pending, startTransition] = useTransition();

  const { attendance } = lesson;
  const beforeCutoff =
    !cutoffPassed && now.getTime() <= new Date(attendance.cutoffAt).getTime();
  const hours = Math.floor(attendance.cutoffMinutes / 60);
  const validUntil = formatDate(attendance.creditValidUntil, "weekdayDate");

  // Result states are announced: focus moves to the alert (§9).
  useEffect(() => {
    if (cutoffPassed || started || error) resultRef.current?.focus();
  }, [cutoffPassed, started, error]);

  function close(next: boolean) {
    if (!next) {
      setReason("");
      setCutoffPassed(false);
      setStarted(false);
      setError(null);
    }
    onOpenChange(next);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await cancelLessonAction({
        lessonId: lesson.id,
        reason,
        expectCredit: beforeCutoff,
      }).catch(() => null);
      if (!result) {
        setError({ key: "common.error.network" });
        return;
      }
      if (!result.ok) {
        const message = result.formError ??
          Object.values(result.fieldErrors ?? {})[0] ?? {
            key: "common.error.unexpected",
          };
        if (message.key === "absences.errors.LESSON_STARTED") setStarted(true);
        else setError(message);
        return;
      }
      if (result.data.status === "cutoffPassed") {
        setCutoffPassed(true);
        return;
      }
      const credit = result.data.credit;
      close(false);
      toast.success(
        credit
          ? t("cancel.doneWithCredit", {
              date: formatDate(credit.validUntil, "weekdayDate"),
            })
          : t("cancel.doneNoCredit"),
        credit
          ? {
              action: {
                label: t("cancel.viewCredits"),
                onClick: () => router.push("/student/absences"),
              },
            }
          : undefined,
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
              group: lesson.oneOnOne
                ? t("oneOnOneWith", { teacher: lesson.teacherName })
                : lesson.groupName,
            })}
          </DialogTitle>
          <DialogDescription className="flex gap-2 tabular-nums">
            <span>{formatDate(lesson.date, "weekdayDate")}</span>
            <span aria-hidden="true">·</span>
            <span>
              {formatMinutes(lesson.startMinute)}–
              {formatMinutes(lesson.endMinute)}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div ref={resultRef} tabIndex={-1} className="outline-none">
          {started ? (
            <ToneAlert tone="danger" icon={Ban}>
              {t("cancel.started")}
            </ToneAlert>
          ) : cutoffPassed ? (
            <ToneAlert tone="warning" icon={AlertTriangle}>
              {t("cancel.cutoffPassed")}
            </ToneAlert>
          ) : beforeCutoff ? (
            <ToneAlert tone="success" icon={Ticket} live>
              {lesson.oneOnOne
                ? t("cancel.creditInfoOneOnOne", {
                    teacher: lesson.teacherName,
                    date: validUntil,
                  })
                : t("cancel.creditInfo", {
                    date: validUntil,
                    level: lesson.level,
                  })}
            </ToneAlert>
          ) : (
            <ToneAlert tone="warning" icon={AlertTriangle} live>
              {hours > 0
                ? t("cancel.noCreditWarning", { hours })
                : t("cancel.noCreditWarningZero")}
              {lesson.oneOnOne && (
                <span className="mt-1 block">{t("cancel.oneOnOneLate")}</span>
              )}
            </ToneAlert>
          )}
          {error && (
            <ToneAlert tone="danger" icon={CircleAlert} className="mt-3">
              {render(error)}
            </ToneAlert>
          )}
        </div>

        {!started && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={reasonId}>{t("cancel.reason")}</Label>
            <Textarea
              id={reasonId}
              rows={2}
              value={reason}
              maxLength={ABSENCE_REASON_MAX + 50}
              placeholder={t("cancel.reasonPlaceholder")}
              aria-describedby={`${hintId} ${counterId}`}
              aria-invalid={reason.trim().length > ABSENCE_REASON_MAX}
              onChange={(event) => setReason(event.target.value)}
              className="text-base"
            />
            <p id={hintId} className="text-xs text-muted-foreground">
              {t("cancel.reasonHint")}
            </p>
            <CharCounter
              id={counterId}
              count={reason.trim().length}
              max={ABSENCE_REASON_MAX}
            />
          </div>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          {!started && (
            <Button
              size="lg"
              className="w-full"
              disabled={pending || reason.trim().length > ABSENCE_REASON_MAX}
              onClick={submit}
            >
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {beforeCutoff ? t("cancel.confirm") : t("cancel.confirmNoCredit")}
            </Button>
          )}
          <Button
            size="lg"
            variant="outline"
            className="w-full"
            disabled={pending}
            onClick={() => close(false)}
          >
            {started ? tc("close") : t("cancel.keep")}
          </Button>
          {!started && (
            <p className="text-center text-xs text-muted-foreground">
              {t("cancel.final")}
            </p>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
