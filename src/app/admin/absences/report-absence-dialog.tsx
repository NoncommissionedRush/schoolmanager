"use client";

import { AlertTriangle, CircleAlert, Loader2, Ticket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useNow, useTranslations } from "next-intl";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { ToneAlert } from "@/components/absences/tone";
import { useMessage } from "@/components/admin/use-message";
import { formatMinutes, useDateFormat } from "@/components/timetable/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { Message } from "@/server/admin/result";
import { ABSENCE_REASON_MAX } from "@/server/replacements/schema";
import type { ReportableLesson } from "@/server/replacements/views";

import { loadReportableLessonsAction, reportAbsenceAction } from "./actions";

/**
 * Report an absence for a student (absences.md §7.5): from the Absences
 * list (pick student and lesson) or a lesson page row (both pre-filled).
 * The same cutoff rule as for students, checked again when saving.
 */
export function ReportAbsenceDialog({
  open,
  onOpenChange,
  students,
  preset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Picker options; omitted when the student is pre-filled. */
  students?: { id: string; name: string }[];
  preset?: { studentId: string; lessonId: string };
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Remount on open so every opening starts fresh. */}
        {open && (
          <ReportAbsenceForm
            students={students}
            preset={preset}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReportAbsenceForm({
  students,
  preset,
  onDone,
}: {
  students?: { id: string; name: string }[];
  preset?: { studentId: string; lessonId: string };
  onDone: () => void;
}) {
  const t = useTranslations("adminAbsences.report");
  const ta = useTranslations("absences.cancel");
  const tc = useTranslations("common");
  const render = useMessage();
  const router = useRouter();
  const formatDate = useDateFormat();
  const now = useNow({ updateInterval: 30_000 });
  const ids = { student: useId(), lesson: useId(), reason: useId() };
  const hintId = useId();

  const [studentId, setStudentId] = useState(preset?.studentId ?? "");
  const [studentName, setStudentName] = useState("");
  const [lessons, setLessons] = useState<ReportableLesson[] | null>(null);
  const [lessonId, setLessonId] = useState(preset?.lessonId ?? "");
  const [reason, setReason] = useState("");
  const [cutoffPassed, setCutoffPassed] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [loading, startLoading] = useTransition();
  const [pending, startSaving] = useTransition();

  useEffect(() => {
    if (!studentId) return;
    startLoading(async () => {
      const result = await loadReportableLessonsAction(studentId);
      if (result.ok) {
        setStudentName(result.data.student.name);
        setLessons(result.data.lessons);
      } else {
        setLessons([]);
        setError(result.formError ?? { key: "common.error.unexpected" });
      }
    });
  }, [studentId]);

  const lesson = lessons?.find((l) => l.id === lessonId) ?? null;
  const beforeCutoff =
    lesson !== null &&
    !cutoffPassed &&
    now.getTime() <= new Date(lesson.cutoffAt).getTime();
  const label = (l: ReportableLesson) =>
    t("lessonOption", {
      dateTime: `${formatDate(l.date, "weekdayDate")}, ${formatMinutes(l.startMinute)}`,
      group: l.groupName,
    });

  function submit() {
    if (!lesson) return;
    setError(null);
    startSaving(async () => {
      const result = await reportAbsenceAction({
        studentId,
        lessonId: lesson.id,
        reason,
        expectCredit: beforeCutoff,
      }).catch(() => null);
      if (!result) {
        setError({ key: "common.error.network" });
        return;
      }
      if (!result.ok) {
        setError(
          result.formError ??
            Object.values(result.fieldErrors ?? {})[0] ?? {
              key: "common.error.unexpected",
            },
        );
        return;
      }
      if (result.data.status === "cutoffPassed") {
        setCutoffPassed(true);
        return;
      }
      toast.success(t("done", { name: result.data.studentName }));
      onDone();
      router.refresh();
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        {students && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={ids.student}>{t("student")}</Label>
            <NativeSelect
              id={ids.student}
              value={studentId}
              onChange={(event) => {
                setStudentId(event.target.value);
                setLessons(null);
                setLessonId("");
                setCutoffPassed(false);
                setError(null);
              }}
            >
              <NativeSelectOption value="">
                {t("chooseStudent")}
              </NativeSelectOption>
              {students.map((s) => (
                <NativeSelectOption key={s.id} value={s.id}>
                  {s.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        {studentId && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={ids.lesson}>{t("lesson")}</Label>
            {loading || lessons === null ? (
              <p className="text-sm text-muted-foreground">{t("loading")}</p>
            ) : lessons.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("noLessons", { name: studentName })}
              </p>
            ) : (
              <NativeSelect
                id={ids.lesson}
                value={lessonId}
                onChange={(event) => {
                  setLessonId(event.target.value);
                  setCutoffPassed(false);
                  setError(null);
                }}
              >
                <NativeSelectOption value="">
                  {t("chooseLesson")}
                </NativeSelectOption>
                {lessons.map((l) => (
                  <NativeSelectOption
                    key={l.id}
                    value={l.id}
                    disabled={l.alreadyCancelled}
                  >
                    {label(l)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </div>
        )}
        {lesson &&
          (lesson.alreadyCancelled ? (
            <ToneAlert tone="warning" icon={AlertTriangle}>
              {t("alreadyCancelled", { name: studentName })}
            </ToneAlert>
          ) : cutoffPassed ? (
            <ToneAlert tone="warning" icon={AlertTriangle}>
              {ta("cutoffPassed")}
            </ToneAlert>
          ) : beforeCutoff ? (
            <ToneAlert tone="success" icon={Ticket} live>
              {t("credit", {
                name: studentName,
                date: formatDate(lesson.creditValidUntil, "weekdayDate"),
              })}
            </ToneAlert>
          ) : (
            <ToneAlert tone="warning" icon={AlertTriangle} live>
              {t("noCredit", { name: studentName })}
            </ToneAlert>
          ))}
        <div className="flex flex-col gap-2">
          <Label htmlFor={ids.reason}>{ta("reason")}</Label>
          <Textarea
            id={ids.reason}
            rows={2}
            value={reason}
            placeholder={t("reasonPlaceholder")}
            aria-describedby={hintId}
            aria-invalid={reason.trim().length > ABSENCE_REASON_MAX}
            onChange={(event) => setReason(event.target.value)}
          />
          <p id={hintId} className="text-xs text-muted-foreground">
            {t("reasonHint")}
          </p>
        </div>
        {error && (
          <ToneAlert tone="danger" icon={CircleAlert}>
            {render(error)}
          </ToneAlert>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={onDone}>
          {tc("cancel")}
        </Button>
        <Button
          disabled={
            pending ||
            !lesson ||
            lesson.alreadyCancelled ||
            reason.trim().length > ABSENCE_REASON_MAX
          }
          onClick={submit}
        >
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {t("action")}
        </Button>
      </DialogFooter>
    </>
  );
}
