"use client";

import { CalendarClock, CalendarX, CircleAlert, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  cancelRescheduledLessonAction,
  rescheduleLessonAction,
} from "@/app/admin/absences/actions";
import { ToneAlert } from "@/components/absences/tone";
import { useMessage } from "@/components/admin/use-message";
import {
  formatMinutes,
  useConflictMessage,
  useDateFormat,
} from "@/components/timetable/format";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { NativeSelect } from "@/components/ui/native-select";
import type { Message } from "@/server/admin/result";
import type { AdminRescheduleResult } from "@/server/replacements/reschedule";

export type AdminRescheduleInfo = {
  lessonId: string;
  date: string;
  startMinute: number;
  endMinute: number;
  durationMinutes: number;
  roomId: string | null;
  rooms: { id: string; name: string }[];
  canReschedule: boolean;
  canCancel: boolean;
  hasCredit: boolean;
};

type Problems = Extract<AdminRescheduleResult, { status: "conflicts" }>;

const toMinutes = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Admin reschedule of a 1-on-1 (replacements.md §7): any upcoming lesson,
 * also after the cutoff. No credit is created or spent. Blocking conflicts
 * refuse; overridable ones and a student clash need a tick each.
 */
export function AdminRescheduleActions({
  info,
}: {
  info: AdminRescheduleInfo;
}) {
  const t = useTranslations("reschedule.admin");
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  return (
    <>
      {info.canReschedule && (
        <Button variant="outline" onClick={() => setOpen(true)}>
          <CalendarClock aria-hidden="true" />
          {t("action")}
        </Button>
      )}
      {info.canCancel && (
        <Button variant="outline" onClick={() => setCancelling(true)}>
          <CalendarX aria-hidden="true" />
          {t("cancel")}
        </Button>
      )}
      {open && <RescheduleDialog info={info} onClose={() => setOpen(false)} />}
      {cancelling && (
        <CancelDialog
          lessonId={info.lessonId}
          onClose={() => setCancelling(false)}
        />
      )}
    </>
  );
}

function RescheduleDialog({
  info,
  onClose,
}: {
  info: AdminRescheduleInfo;
  onClose: () => void;
}) {
  const t = useTranslations("reschedule.admin");
  const tc = useTranslations("common");
  const format = useFormatter();
  const formatDate = useDateFormat();
  const conflictMessage = useConflictMessage();
  const render = useMessage();
  const router = useRouter();
  const [date, setDate] = useState(info.date);
  const [time, setTime] = useState(formatMinutes(info.startMinute));
  const [duration, setDuration] = useState(String(info.durationMinutes));
  const [roomId, setRoomId] = useState(info.roomId ?? "");
  const [note, setNote] = useState("");
  const [problems, setProblems] = useState<Problems | null>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [error, setError] = useState<Message | null>(null);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setProblems(null);
    setAcknowledged([]);
  };
  const reasonText = (r: Problems["reasons"][number]) =>
    r.code === "STUDENT_CLASH"
      ? t("reasons.STUDENT_CLASH", {
          lessons: (r.clashes ?? [])
            .map(
              (c) =>
                `${c.group}, ${formatDate(c.date, "dayMonth")} ${formatMinutes(c.startMinute)}`,
            )
            .join("; "),
        })
      : t(`reasons.${r.code}`);
  const items = problems
    ? [
        ...problems.conflicts.map((c) => ({
          key: c.key,
          blocking: c.severity === "blocking",
          text: conflictMessage(c),
        })),
        ...problems.reasons.map((r) => ({
          key: r.key,
          blocking: r.code !== "STUDENT_CLASH",
          text: reasonText(r),
        })),
      ]
    : [];
  const blocked = items.some((i) => i.blocking);
  const ready = items
    .filter((i) => !i.blocking)
    .every((i) => acknowledged.includes(i.key));

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await rescheduleLessonAction({
        lessonId: info.lessonId,
        date,
        startMinute: toMinutes(time),
        durationMinutes: Number(duration),
        roomId: roomId || null,
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
      if (result.data.status === "conflicts") {
        setProblems(result.data);
        return;
      }
      toast.success(
        t("done", {
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
      router.push(`/admin/lessons/${result.data.lessonId}`);
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="reschedule-date">{t("date")}</Label>
            <Input
              id="reschedule-date"
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                reset();
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="reschedule-time">{t("start")}</Label>
            <Input
              id="reschedule-time"
              type="time"
              step={300}
              value={time}
              onChange={(event) => {
                setTime(event.target.value);
                reset();
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="reschedule-duration">{t("duration")}</Label>
            <Input
              id="reschedule-duration"
              type="number"
              min={5}
              max={480}
              step={5}
              value={duration}
              onChange={(event) => {
                setDuration(event.target.value);
                reset();
              }}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="reschedule-room">{t("room")}</Label>
          <NativeSelect
            id="reschedule-room"
            value={roomId}
            onChange={(event) => {
              setRoomId(event.target.value);
              reset();
            }}
          >
            <option value="">{t("noRoom")}</option>
            {info.rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="reschedule-note">{t("note")}</Label>
          <Input
            id="reschedule-note"
            value={note}
            maxLength={300}
            placeholder={t("notePlaceholder")}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        {problems && items.length > 0 && (
          <div className="flex flex-col gap-2 text-sm" role="alert">
            <p>{blocked ? t("blocking") : t("conflicts")}</p>
            <ul className="flex flex-col gap-1">
              {items.map((item) =>
                item.blocking ? (
                  <li key={item.key} className="text-destructive">
                    {item.text}
                  </li>
                ) : (
                  <li key={item.key} className="flex items-start gap-2">
                    <Checkbox
                      id={`ack-${item.key}`}
                      checked={acknowledged.includes(item.key)}
                      onCheckedChange={(checked) =>
                        setAcknowledged((current) =>
                          checked
                            ? [...current, item.key]
                            : current.filter((k) => k !== item.key),
                        )
                      }
                    />
                    <Label htmlFor={`ack-${item.key}`} className="font-normal">
                      {t("acknowledge", { conflict: item.text })}
                    </Label>
                  </li>
                ),
              )}
            </ul>
          </div>
        )}
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
            disabled={pending || blocked || (problems !== null && !ready)}
            onClick={run}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelDialog({
  lessonId,
  onClose,
}: {
  lessonId: string;
  onClose: () => void;
}) {
  const t = useTranslations("reschedule.admin");
  const render = useMessage();
  const router = useRouter();
  const [error, setError] = useState<Message | null>(null);
  const [pending, startTransition] = useTransition();
  function run() {
    startTransition(async () => {
      const result = await cancelRescheduledLessonAction(lessonId).catch(
        () => null,
      );
      if (!result) return setError({ key: "common.error.network" });
      if (!result.ok) {
        return setError(result.formError ?? { key: "common.error.unexpected" });
      }
      toast.success(t("cancelled"));
      onClose();
      router.refresh();
    });
  }
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("cancelTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("cancelBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <ToneAlert tone="danger" icon={CircleAlert}>
            {render(error)}
          </ToneAlert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t("cancelKeep")}
          </AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={run}>
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {t("cancelConfirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
