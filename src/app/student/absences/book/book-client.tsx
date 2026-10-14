"use client";

import { AlertTriangle, Loader2, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { bookReplacementAction } from "@/app/student/absences/actions";
import { useReasonText } from "@/components/absences/reason-text";
import { ToneAlert } from "@/components/absences/tone";
import { useMessage } from "@/components/admin/use-message";
import { formatMinutes, useDateFormat } from "@/components/timetable/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { Message } from "@/server/admin/result";
import type { EligibleLesson } from "@/server/replacements/booking";

type Credit = { id: string; sourceDate: string; validUntil: string };

/** "Use credit from {date}" when the student has several group credits. */
export function CreditSwitch({
  current,
  others,
}: {
  current: Credit;
  others: Credit[];
}) {
  const t = useTranslations("replacements.book");
  const formatDate = useDateFormat();
  const router = useRouter();
  const credits = [current, ...others].sort((a, b) =>
    a.validUntil.localeCompare(b.validUntil),
  );
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor="credit-switch">
        {t("switchCredit", {
          date: formatDate(current.sourceDate, "dayMonth"),
        })}
      </Label>
      <NativeSelect
        id="credit-switch"
        value={current.id}
        onChange={(event) =>
          router.push(`/student/absences/book?credit=${event.target.value}`)
        }
      >
        {credits.map((credit) => (
          <option key={credit.id} value={credit.id}>
            {t("switchCredit", {
              date: formatDate(credit.sourceDate, "dayMonth"),
            })}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

/** One week of bookable lessons, by day, each with Book + confirm (§5.5). */
export function BookingList({
  credit,
  lessons,
}: {
  credit: Credit;
  lessons: EligibleLesson[];
}) {
  const t = useTranslations("replacements.book");
  const format = useFormatter();
  const formatDate = useDateFormat();
  const [confirming, setConfirming] = useState<EligibleLesson | null>(null);
  const days = [...new Set(lessons.map((l) => l.date))].sort();
  const dateTime = (l: EligibleLesson) =>
    `${formatDate(l.date, "weekdayLong")}, ${formatMinutes(l.startMinute)}`;

  return (
    <>
      {days.map((day) => (
        <section key={day} className="flex flex-col gap-2">
          <h3 className="font-semibold">{formatDate(day, "weekdayLong")}</h3>
          <ul className="flex flex-col gap-2">
            {lessons
              .filter((l) => l.date === day)
              .map((lesson) => (
                <li key={lesson.id}>
                  <Card className="border-l-4 border-l-lesson-group bg-lesson-group-surface">
                    <CardContent className="flex flex-col gap-1">
                      <p className="flex items-center gap-2 font-medium">
                        <span className="tabular-nums">
                          {formatMinutes(lesson.startMinute)}–
                          {formatMinutes(lesson.endMinute)}
                        </span>
                        <Users aria-hidden="true" className="size-4" />
                        <span>{lesson.groupName}</span>
                      </p>
                      <p className="text-sm">
                        {lesson.online
                          ? t("online")
                          : (lesson.roomName ?? t("noRoom"))}{" "}
                        · {lesson.teacherName}
                      </p>
                      {lesson.seatsLeft !== null && (
                        <p
                          className={
                            lesson.seatsLeft === 1
                              ? "text-sm text-warning"
                              : "text-sm text-muted-foreground"
                          }
                          aria-label={t("seatsLeftLabel", {
                            count: lesson.seatsLeft,
                            room: lesson.roomName ?? "",
                          })}
                        >
                          {t("seatsLeft", { count: lesson.seatsLeft })}
                        </p>
                      )}
                      <Button
                        size="lg"
                        className="mt-1 self-start"
                        aria-label={t("actionLabel", {
                          group: lesson.groupName,
                          dateTime: dateTime(lesson),
                        })}
                        onClick={() => setConfirming(lesson)}
                      >
                        {t("action")}
                      </Button>
                    </CardContent>
                  </Card>
                </li>
              ))}
          </ul>
        </section>
      ))}
      {confirming && (
        <ConfirmDialog
          credit={credit}
          lesson={confirming}
          cutoff={format.dateTime(new Date(confirming.cutoffAt), {
            weekday: "short",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
          dateTime={dateTime(confirming)}
          onClose={() => setConfirming(null)}
        />
      )}
    </>
  );
}

function ConfirmDialog({
  credit,
  lesson,
  cutoff,
  dateTime,
  onClose,
}: {
  credit: Credit;
  lesson: EligibleLesson;
  cutoff: string;
  dateTime: string;
  onClose: () => void;
}) {
  const t = useTranslations("replacements.book");
  const formatDate = useDateFormat();
  const render = useMessage();
  const reasonText = useReasonText();
  const router = useRouter();
  const [refused, setRefused] = useState<string | null>(null);
  const [error, setError] = useState<Message | null>(null);
  const [pending, startTransition] = useTransition();

  function book() {
    setError(null);
    startTransition(async () => {
      const result = await bookReplacementAction({
        creditId: credit.id,
        targetLessonId: lesson.id,
      }).catch(() => null);
      if (!result) {
        setError({ key: "common.error.network" });
        return;
      }
      if (!result.ok) {
        setError(result.formError ?? { key: "common.error.unexpected" });
        return;
      }
      if (result.data.status === "refused") {
        // A lost race (§8): say why, and refresh the list behind.
        const first = result.data.reasons[0];
        setRefused(
          first?.code === "ROOM_FULL"
            ? t("seatTaken")
            : t("refused", { reason: first ? reasonText(first) : "" }),
        );
        router.refresh();
        return;
      }
      onClose();
      toast.success(t("done", { dateTime }), {
        action: {
          label: t("viewTimetable"),
          onClick: () => router.push(`/student/timetable?week=${lesson.date}`),
        },
      });
      router.push("/student/absences");
      router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("confirmTitle", { group: lesson.groupName, dateTime })}
          </DialogTitle>
          <DialogDescription>
            {t("confirmBody", {
              sourceDate: formatDate(credit.sourceDate, "dayMonth"),
              cutoff,
            })}
          </DialogDescription>
        </DialogHeader>
        {refused && (
          <ToneAlert tone="warning" icon={AlertTriangle}>
            {refused}
          </ToneAlert>
        )}
        {error && (
          <ToneAlert tone="danger" icon={AlertTriangle}>
            {render(error)}
          </ToneAlert>
        )}
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          {!refused && (
            <Button
              size="lg"
              className="w-full"
              disabled={pending}
              onClick={book}
            >
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {t("action")}
            </Button>
          )}
          <Button
            size="lg"
            variant="outline"
            className="w-full"
            disabled={pending}
            onClick={onClose}
          >
            {t("confirmBack")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
