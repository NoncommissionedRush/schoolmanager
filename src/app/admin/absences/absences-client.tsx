"use client";

import {
  CalendarClock,
  CalendarX,
  CircleAlert,
  EllipsisVertical,
  ExternalLink,
  Loader2,
  Repeat,
  Trash2,
  User,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { RescheduleDialog } from "@/app/admin/lessons/[id]/reschedule-dialog";
import { ToneAlert } from "@/components/absences/tone";
import { useMessage } from "@/components/admin/use-message";
import {
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
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Message } from "@/server/admin/result";
import type { Conflict } from "@/server/scheduling";

import { deleteAbsenceAction } from "./actions";
import { BookForStudentDialog } from "./credit-dialogs";
import { ReportAbsenceDialog } from "./report-absence-dialog";

/** "Report absence" primary button on the Absences tab (§7.5). */
export function ReportAbsenceButton({
  students,
}: {
  students: { id: string; name: string }[];
}) {
  const t = useTranslations("adminAbsences.report");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <CalendarX aria-hidden="true" />
        {t("action")}
      </Button>
      <ReportAbsenceDialog
        open={open}
        onOpenChange={setOpen}
        students={students}
      />
    </>
  );
}

/** Lesson-date range with presets (§7.2); kept in the URL. */
export function PeriodFilter({
  from,
  to,
  presets,
}: {
  from: string;
  to: string;
  presets: { label: string; from: string; to: string }[];
}) {
  const t = useTranslations("adminAbsences.filter");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const href = (range: { from: string; to: string }) => {
    const next = new URLSearchParams(params.toString());
    next.set("from", range.from);
    next.set("to", range.to);
    next.delete("page");
    return `${pathname}?${next}`;
  };
  const update = (name: "from" | "to", value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    router.replace(href({ from, to, [name]: value }), { scroll: false });
  };
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1 text-sm">
        <Label
          htmlFor="absences-from"
          className="font-normal text-muted-foreground"
        >
          {t("from")}
        </Label>
        <Input
          id="absences-from"
          type="date"
          defaultValue={from}
          key={`from-${from}`}
          onChange={(event) => update("from", event.target.value)}
          className="w-40"
        />
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <Label
          htmlFor="absences-to"
          className="font-normal text-muted-foreground"
        >
          {t("to")}
        </Label>
        <Input
          id="absences-to"
          type="date"
          defaultValue={to}
          key={`to-${to}`}
          onChange={(event) => update("to", event.target.value)}
          className="w-40"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => {
          const active = preset.from === from && preset.to === to;
          return (
            <Link
              key={preset.label}
              href={href(preset)}
              scroll={false}
              aria-current={active ? "true" : undefined}
              className={buttonVariants({
                variant: active ? "secondary" : "outline",
                size: "sm",
              })}
            >
              {preset.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

type AbsenceRow = {
  id: string;
  studentId: string;
  studentName: string;
  lessonId: string;
  date: string;
  oneOnOne: boolean;
  creditUsed: boolean;
  /** An AVAILABLE credit the admin can spend for the student (CARM-47). */
  availableCredit: {
    id: string;
    validUntil: string;
    /** Defaults of a 1-on-1's new lesson: the missed one's time and room. */
    suggestedDate: string;
    startMinute: number;
    durationMinutes: number;
    roomId: string | null;
  } | null;
};

/**
 * Row menu of the Absences tab (§7.2): open lesson / student, spend an
 * available credit for the student (Book replacement… for a group lesson,
 * Book 1-on-1 with credit… for a 1-on-1), delete.
 */
export function AbsenceRowActions({
  absence,
  rooms,
}: {
  absence: AbsenceRow;
  rooms: { id: string; name: string }[];
}) {
  const t = useTranslations("adminAbsences");
  const tr = useTranslations("reschedule.admin");
  const [deleting, setDeleting] = useState(false);
  const [spending, setSpending] = useState(false);
  const credit = absence.availableCredit;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("col.actions")}
            />
          }
        >
          <EllipsisVertical aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            render={<Link href={`/admin/lessons/${absence.lessonId}`} />}
          >
            <ExternalLink aria-hidden="true" />
            {t("openLesson")}
          </DropdownMenuItem>
          <DropdownMenuItem
            render={<Link href={`/admin/students/${absence.studentId}`} />}
          >
            <User aria-hidden="true" />
            {t("openStudent")}
          </DropdownMenuItem>
          {credit && (
            <DropdownMenuItem onClick={() => setSpending(true)}>
              {absence.oneOnOne ? (
                <CalendarClock aria-hidden="true" />
              ) : (
                <Repeat aria-hidden="true" />
              )}
              {absence.oneOnOne ? tr("actionCredit") : t("book.action")}
            </DropdownMenuItem>
          )}
          {absence.creditUsed ? (
            <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
              {t("delete.creditUsed")}
            </p>
          ) : (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setDeleting(true)}
            >
              <Trash2 aria-hidden="true" />
              {t("delete.action")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteAbsenceDialog
        absence={absence}
        open={deleting}
        onOpenChange={setDeleting}
      />
      {spending && credit && absence.oneOnOne && (
        <RescheduleDialog
          info={{
            lessonId: absence.lessonId,
            date: credit.suggestedDate,
            startMinute: credit.startMinute,
            durationMinutes: credit.durationMinutes,
            roomId: credit.roomId,
            rooms,
          }}
          credit={{
            id: credit.id,
            studentName: absence.studentName,
            sourceDate: absence.date,
            validUntil: credit.validUntil,
          }}
          onClose={() => setSpending(false)}
        />
      )}
      {spending && credit && !absence.oneOnOne && (
        <BookForStudentDialog
          creditId={credit.id}
          studentName={absence.studentName}
          onClose={() => setSpending(false)}
        />
      )}
    </>
  );
}

/**
 * Delete absence… (§7.5). A 1-on-1 the absence cancelled comes back only
 * without blocking conflicts; overridable ones need a tick each, like the
 * timetable editor.
 */
function DeleteAbsenceDialog({
  absence,
  open,
  onOpenChange,
}: {
  absence: AbsenceRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("adminAbsences.delete");
  const tc = useTranslations("common");
  const render = useMessage();
  const conflictMessage = useConflictMessage();
  const formatDate = useDateFormat();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<Message | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);

  const blocking = conflicts?.filter((c) => c.severity === "blocking") ?? [];
  const overridable =
    conflicts?.filter((c) => c.severity === "overridable") ?? [];
  const allAcknowledged = overridable.every((c) =>
    acknowledged.includes(c.key),
  );

  function close(next: boolean) {
    if (!next) {
      setError(null);
      setConflicts(null);
      setAcknowledged([]);
    }
    onOpenChange(next);
  }

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await deleteAbsenceAction(absence.id, acknowledged).catch(
        () => null,
      );
      if (!result) {
        setError({ key: "common.error.network" });
        return;
      }
      if (!result.ok) {
        setError(result.formError ?? { key: "common.error.unexpected" });
        return;
      }
      if (result.data.status === "conflicts") {
        setConflicts(result.data.conflicts);
        return;
      }
      const over = result.data.overCapacity;
      toast.success(
        over ? `${t("done")} ${t("overCapacity", over)}` : t("done"),
      );
      close(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("title", {
              name: absence.studentName,
              date: formatDate(absence.date, "weekdayDate"),
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {absence.oneOnOne
              ? t("bodyOneOnOne", { name: absence.studentName })
              : t("body", { name: absence.studentName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {conflicts && conflicts.length > 0 && (
          <div className="flex flex-col gap-2 text-sm">
            <p>{t("conflicts")}</p>
            <ul className="flex flex-col gap-1">
              {blocking.map((c) => (
                <li key={c.key} className="text-destructive">
                  {conflictMessage(c)}
                </li>
              ))}
              {overridable.map((c) => (
                <li key={c.key} className="flex items-start gap-2">
                  <Checkbox
                    id={`ack-${c.key}`}
                    checked={acknowledged.includes(c.key)}
                    onCheckedChange={(checked) =>
                      setAcknowledged((current) =>
                        checked
                          ? [...current, c.key]
                          : current.filter((k) => k !== c.key),
                      )
                    }
                  />
                  <Label htmlFor={`ack-${c.key}`} className="font-normal">
                    {t("acknowledge", { conflict: conflictMessage(c) })}
                  </Label>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <ToneAlert tone="danger" icon={CircleAlert}>
            {render(error)}
          </ToneAlert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {tc("cancel")}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending || blocking.length > 0 || !allAcknowledged}
            onClick={run}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {t("confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
