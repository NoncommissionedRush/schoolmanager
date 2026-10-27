"use client";

import {
  Check,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog, FormDialog } from "@/components/admin/dialogs";
import {
  CheckboxGroupField,
  RadioGroupField,
  TextField,
} from "@/components/admin/fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  availableExceptionHasNoEffect,
  expandDateRange,
} from "@/server/admin/availability/rules";
import {
  exceptionSchema,
  weeklySchema,
} from "@/server/admin/availability/schema";
import { formatMinutes } from "@/server/scheduling/time";

import {
  approveAvailabilityRequestAction,
  deleteAvailabilityAction,
  rejectAvailabilityRequestAction,
  saveExceptionAction,
  saveWeeklyAction,
} from "@/app/admin/teachers/actions";
import {
  requestDeleteAction,
  requestExceptionAction,
  requestWeeklyAction,
  withdrawRequestAction,
} from "@/app/teacher/availability/actions";
import {
  RECENT_DECISION_DAYS,
  rejectSchema,
  type RequestView,
  type RuleSnapshot,
} from "@/server/availability-requests/schema";

export type WeeklyRule = {
  id: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  note: string | null;
};

export type Exception = {
  id: string;
  kind: "DATE_UNAVAILABLE" | "DATE_AVAILABLE";
  date: string;
  startMinute: number | null;
  endMinute: number | null;
  note: string | null;
  past: boolean;
};

/**
 * `admin` edits the rules directly (admin-data.md §6.4); `teacher` edits
 * their own, and every change becomes a request an admin approves
 * (availability-requests.md).
 */
export type AvailabilityMode = "admin" | "teacher";

type Props = {
  mode: AvailabilityMode;
  teacherId: string;
  name: string;
  teachingWeekdays: number[];
  weekly: WeeklyRule[];
  exceptions: Exception[];
  requests: { pending: RequestView[]; recent: RequestView[] };
};

/** The actions behind the dialogs, per mode. */
function actionsFor(mode: AvailabilityMode, teacherId: string) {
  return mode === "admin"
    ? {
        saveWeekly: (
          replaceId: string | null,
          previous: unknown,
          data: FormData,
        ) => saveWeeklyAction(teacherId, replaceId, previous, data),
        saveException: (previous: unknown, data: FormData) =>
          saveExceptionAction(teacherId, previous, data),
        remove: (id: string) => deleteAvailabilityAction(teacherId, id),
      }
    : {
        saveWeekly: requestWeeklyAction,
        saveException: requestExceptionAction,
        remove: requestDeleteAction,
      };
}

/** Availability (§6.4): weekly unavailability + one-off exceptions. */
export function AvailabilityEditor(props: Props) {
  const t = useTranslations("availability");
  const tr = useTranslations("availabilityRequests");
  const firstName = props.name.split(/\s+/)[0];
  const showRequests =
    props.mode === "teacher" || props.requests.pending.length > 0;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {props.mode === "admin" ? t("lead", { firstName }) : tr("teacherLead")}
      </p>
      {showRequests && <RequestsCard {...props} firstName={firstName} />}
      <WeeklyCard {...props} firstName={firstName} />
      <ExceptionsCard {...props} />
    </div>
  );
}

function pendingTargets(requests: Props["requests"]) {
  return new Set(
    requests.pending.flatMap((request) =>
      request.targetId ? [request.targetId] : [],
    ),
  );
}

function PendingBadge() {
  const tr = useTranslations("availabilityRequests");
  return (
    <Badge variant="outline" className="ml-2">
      {tr("pendingBadge")}
    </Badge>
  );
}

function WeeklyCard({
  mode,
  teacherId,
  name,
  firstName,
  teachingWeekdays,
  weekly,
  requests,
}: Props & { firstName: string }) {
  const t = useTranslations("availability");
  const tr = useTranslations("availabilityRequests");
  const tc = useTranslations("common");
  const actions = actionsFor(mode, teacherId);
  const deleteCopy = useDeleteCopy(mode);
  const pending = pendingTargets(requests);
  const [editing, setEditing] = useState<WeeklyRule | "new" | null>(null);
  const [deleting, setDeleting] = useState<WeeklyRule | null>(null);
  const labelOf = (rule: WeeklyRule) => ({
    weekday: tc(`weekday.${rule.weekday}` as "weekday.1"),
    from: formatMinutes(rule.startMinute),
    to: formatMinutes(rule.endMinute),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("weekly.title")}</h2>
        </CardTitle>
        <CardAction>
          <Button variant="outline" onClick={() => setEditing("new")}>
            <Plus aria-hidden="true" />
            {t("weekly.add")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {weekly.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {mode === "admin"
              ? t("weekly.empty", { firstName })
              : tr("teacher.weeklyEmpty")}
          </p>
        ) : (
          <ul
            className="flex flex-col divide-y"
            aria-label={t("weekly.caption", { name })}
          >
            {weekly.map((rule) => (
              <li
                key={rule.id}
                className="flex items-center justify-between gap-2 py-2"
              >
                <span className="text-sm">
                  {t("weekly.row", labelOf(rule))}
                  {rule.note && (
                    <span className="text-muted-foreground">
                      {" · "}
                      {rule.note}
                    </span>
                  )}
                  {pending.has(rule.id) && <PendingBadge />}
                </span>
                {!(mode === "teacher" && pending.has(rule.id)) && (
                  <span className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("weekly.editLabel", labelOf(rule))}
                      onClick={() => setEditing(rule)}
                    >
                      <Pencil aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("weekly.deleteLabel", labelOf(rule))}
                      onClick={() => setDeleting(rule)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing === "new" ? t("weekly.addTitle") : t("weekly.editTitle")}
        submitLabel={mode === "admin" ? t("save") : tr("send")}
        schema={weeklySchema}
        action={(previous, formData) =>
          actions.saveWeekly(
            editing && editing !== "new" ? editing.id : null,
            previous,
            formData,
          )
        }
      >
        <CheckboxGroupField
          name="weekdays"
          legend={t("field.weekdays")}
          options={[1, 2, 3, 4, 5, 6, 7].map((day) => ({
            value: String(day),
            label: teachingWeekdays.includes(day)
              ? tc(`weekdayShort.${day}` as "weekdayShort.1")
              : `${tc(`weekdayShort.${day}` as "weekdayShort.1")} ${tc("noSchool")}`,
          }))}
          defaultValues={
            editing && editing !== "new" ? [String(editing.weekday)] : []
          }
        />
        <div className="grid grid-cols-2 gap-4">
          <TextField
            name="from"
            type="time"
            label={t("field.from")}
            defaultValue={
              editing && editing !== "new"
                ? formatMinutes(editing.startMinute)
                : undefined
            }
          />
          <TextField
            name="to"
            type="time"
            label={t("field.to")}
            defaultValue={
              editing && editing !== "new"
                ? formatMinutes(editing.endMinute)
                : undefined
            }
          />
        </div>
        <TextField
          name="note"
          label={t("field.note")}
          optional
          defaultValue={editing && editing !== "new" ? editing.note : undefined}
        />
      </FormDialog>
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          {...deleteCopy(
            t("weekly.deleteTitle", labelOf(deleting)),
            t("weekly.row", labelOf(deleting)),
          )}
          run={() => actions.remove(deleting.id)}
        />
      )}
    </Card>
  );
}

function ExceptionsCard({
  mode,
  teacherId,
  name,
  weekly,
  exceptions,
  requests,
}: Props) {
  const t = useTranslations("availability");
  const tc = useTranslations("common");
  const actions = actionsFor(mode, teacherId);
  const deleteCopy = useDeleteCopy(mode);
  const pending = pendingTargets(requests);
  const format = useFormatter();
  const router = useRouter();
  const switchId = useId();
  const [showPast, setShowPast] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Exception | null>(null);
  const visible = exceptions.filter((exception) => showPast || !exception.past);
  const formatDate = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("exceptions.title")}</h2>
        </CardTitle>
        <CardAction>
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            {t("exceptions.add")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {exceptions.some((exception) => exception.past) && (
          <div className="flex items-center gap-2">
            <Switch
              id={switchId}
              checked={showPast}
              onCheckedChange={setShowPast}
            />
            <Label htmlFor={switchId}>{t("exceptions.showPast")}</Label>
          </div>
        )}
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("exceptions.empty")}
          </p>
        ) : (
          <Table>
            <TableCaption className="sr-only">
              {t("exceptions.caption", { name })}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("exceptions.col.date")}</TableHead>
                <TableHead>{t("exceptions.col.type")}</TableHead>
                <TableHead>{t("exceptions.col.time")}</TableHead>
                <TableHead>{t("exceptions.col.note")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("exceptions.col.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((exception) => (
                <TableRow key={exception.id}>
                  <TableCell>{formatDate(exception.date)}</TableCell>
                  <TableCell>
                    {exception.kind === "DATE_UNAVAILABLE" ? (
                      <Badge className="bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                        {t("badge.unavailable")}
                      </Badge>
                    ) : (
                      <Badge className="bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-100">
                        {t("badge.available")}
                      </Badge>
                    )}
                    {pending.has(exception.id) && <PendingBadge />}
                  </TableCell>
                  <TableCell>
                    {exception.startMinute === null ||
                    exception.endMinute === null
                      ? t("wholeDay")
                      : tc("timeRange", {
                          from: formatMinutes(exception.startMinute),
                          to: formatMinutes(exception.endMinute),
                        })}
                  </TableCell>
                  <TableCell>{exception.note ?? tc("none")}</TableCell>
                  <TableCell className="text-right">
                    {!(mode === "teacher" && pending.has(exception.id)) && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("exceptions.deleteLabel", {
                          date: formatDate(exception.date),
                        })}
                        onClick={() => setDeleting(exception)}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <ExceptionDialog
        mode={mode}
        teacherId={teacherId}
        weekly={weekly}
        open={adding}
        onOpenChange={setAdding}
        onImpact={(count) =>
          toast.warning(t("savedWithImpact", { count }), {
            duration: 10_000,
            action: {
              label: t("viewInTimetable"),
              onClick: () =>
                router.push(`/admin/timetable?teacher=${teacherId}`),
            },
          })
        }
      />
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          {...deleteCopy(
            t("exceptions.deleteTitle", { date: formatDate(deleting.date) }),
            formatDate(deleting.date),
          )}
          run={() => actions.remove(deleting.id)}
        />
      )}
    </Card>
  );
}

function ExceptionDialog({
  mode,
  teacherId,
  weekly,
  open,
  onOpenChange,
  onImpact,
}: {
  mode: AvailabilityMode;
  teacherId: string;
  weekly: WeeklyRule[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImpact: (count: number) => void;
}) {
  const t = useTranslations("availability");
  const tr = useTranslations("availabilityRequests");
  const actions = actionsFor(mode, teacherId);
  const switchId = useId();
  const [kind, setKind] = useState("DATE_UNAVAILABLE");
  const [wholeDay, setWholeDay] = useState(true);
  const [noEffect, setNoEffect] = useState(false);

  // Live warning (§6.4): an "available" exception on a day without weekly
  // unavailability changes nothing. A warning, not an error.
  function recheck(event: FormEvent<HTMLDivElement>) {
    const form = event.currentTarget.closest("form");
    if (!form) return;
    const data = new FormData(form);
    const value = (key: string) => String(data.get(key) ?? "");
    const date = value("date");
    const dates = /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? (expandDateRange(date, value("dateTo") || null) ?? [])
      : [];
    const toMinutes = (time: string) => {
      const [h, m] = time.split(":").map(Number);
      return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
    };
    const from = toMinutes(value("from"));
    const to = toMinutes(value("to"));
    const window =
      value("wholeDay") === "on" || from === null || to === null || from >= to
        ? null
        : { startMinute: from, endMinute: to };
    setNoEffect(
      value("kind") === "DATE_AVAILABLE" &&
        availableExceptionHasNoEffect(dates, window, weekly),
    );
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setKind("DATE_UNAVAILABLE");
          setWholeDay(true);
          setNoEffect(false);
        }
        onOpenChange(next);
      }}
      title={t("exceptions.addTitle")}
      submitLabel={mode === "admin" ? t("save") : tr("send")}
      schema={exceptionSchema}
      action={actions.saveException}
      onSuccess={(data) => {
        if (data.affected > 0) onImpact(data.affected);
      }}
    >
      <div className="flex flex-col gap-4" onChange={recheck}>
        <RadioGroupField
          name="kind"
          legend={t("field.type")}
          value={kind}
          onChange={setKind}
          options={[
            { value: "DATE_UNAVAILABLE", label: t("type.unavailable") },
            { value: "DATE_AVAILABLE", label: t("type.available") },
          ]}
        />
        <div className="grid grid-cols-2 gap-4">
          <TextField name="date" type="date" label={t("field.date")} />
          <TextField
            name="dateTo"
            type="date"
            label={t("field.dateTo")}
            optional
            hint={t("field.dateToHint")}
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={switchId}
            checked={wholeDay}
            onCheckedChange={setWholeDay}
          />
          <Label htmlFor={switchId}>{t("field.wholeDay")}</Label>
          <input type="hidden" name="wholeDay" value={wholeDay ? "on" : ""} />
        </div>
        {!wholeDay && (
          <div className="grid grid-cols-2 gap-4">
            <TextField name="from" type="time" label={t("field.from")} />
            <TextField name="to" type="time" label={t("field.to")} />
          </div>
        )}
        <TextField name="note" label={t("field.note")} optional />
        {noEffect && (
          <p
            role="status"
            className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4" />
            {t("warning.noWeeklyRule")}
          </p>
        )}
      </div>
    </FormDialog>
  );
}

/** Admins delete right away; a teacher's delete is a request. */
function useDeleteCopy(mode: AvailabilityMode) {
  const tr = useTranslations("availabilityRequests");
  const tc = useTranslations("common");
  return (adminTitle: string, rule: string) =>
    mode === "admin"
      ? {
          title: adminTitle,
          description: tc("confirm.irreversible"),
          confirmLabel: tc("delete"),
          destructive: true,
        }
      : {
          title: tr("teacher.deleteTitle", { rule }),
          description: tr("teacher.deleteDescription"),
          confirmLabel: tr("teacher.deleteConfirm"),
          destructive: false,
        };
}

function useFormatDate() {
  const format = useFormatter();
  return (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
}

/** One line per part of a request: what changes, what it was, its note. */
function useRequestLines() {
  const t = useTranslations("availability");
  const tr = useTranslations("availabilityRequests");
  const tc = useTranslations("common");
  const format = useFormatter();
  const formatDate = useFormatDate();
  const timeOf = (startMinute: number | null, endMinute: number | null) =>
    startMinute === null || endMinute === null
      ? t("wholeDay")
      : tc("timeRange", {
          from: formatMinutes(startMinute),
          to: formatMinutes(endMinute),
        });
  const weekdayName = (day: number) => tc(`weekday.${day}` as "weekday.1");
  const ruleLine = (rule: RuleSnapshot) =>
    rule.kind === "WEEKLY_UNAVAILABLE"
      ? t("weekly.row", {
          weekday: weekdayName(rule.weekday ?? 1),
          from: formatMinutes(rule.startMinute ?? 0),
          to: formatMinutes(rule.endMinute ?? 0),
        })
      : tr("detail.exceptionRule", {
          kind: rule.kind,
          date: formatDate(rule.date ?? ""),
          time: timeOf(rule.startMinute, rule.endMinute),
        });
  return (request: RequestView): { summary: string; lines: string[] } => {
    const lines: string[] = [];
    let note: string | null = null;
    switch (request.kind) {
      case "ADD_WEEKLY":
      case "EDIT_WEEKLY":
        lines.push(
          tr("detail.weekly", {
            weekdays: format.list(request.weekly.weekdays.map(weekdayName), {
              type: "conjunction",
            }),
            from: formatMinutes(request.weekly.startMinute),
            to: formatMinutes(request.weekly.endMinute),
          }),
        );
        if (request.kind === "EDIT_WEEKLY") {
          lines.push(tr("detail.was", { rule: ruleLine(request.target) }));
        }
        note = request.weekly.note;
        break;
      case "ADD_EXCEPTION": {
        const { dates, window } = request.exception;
        const first = dates[0];
        const last = dates.at(-1) ?? first;
        lines.push(
          tr("detail.exception", {
            kind: request.exception.kind,
            range:
              first === last
                ? formatDate(first)
                : tr("detail.range", {
                    from: formatDate(first),
                    to: formatDate(last),
                  }),
            time: timeOf(
              window?.startMinute ?? null,
              window?.endMinute ?? null,
            ),
          }),
        );
        note = request.exception.note;
        break;
      }
      case "DELETE_RULE":
        lines.push(ruleLine(request.target));
        note = request.target.note;
        break;
    }
    if (note) lines.push(tr("detail.note", { note }));
    const summary = tr("summary", {
      kind: tr(`kind.${request.kind}`),
      detail: lines[0],
    });
    return { summary, lines };
  };
}

/**
 * Pending requests (and, for the teacher, the recently decided ones).
 * Admins approve or decline; the teacher can withdraw while it's pending.
 */
function RequestsCard({
  mode,
  teacherId,
  firstName,
  requests,
}: Props & { firstName: string }) {
  const tr = useTranslations("availabilityRequests");
  const format = useFormatter();
  const router = useRouter();
  const t = useTranslations("availability");
  const linesOf = useRequestLines();
  const [approving, setApproving] = useState<RequestView | null>(null);
  const [rejecting, setRejecting] = useState<RequestView | null>(null);
  const [withdrawing, setWithdrawing] = useState<RequestView | null>(null);
  const dateOf = (iso: string) =>
    format.dateTime(new Date(iso), { day: "numeric", month: "short" });

  const item = (request: RequestView) => {
    const { summary, lines } = linesOf(request);
    return (
      <li
        key={request.id}
        className="flex flex-wrap items-start justify-between gap-2 py-3"
      >
        <div className="flex min-w-0 flex-col gap-0.5 text-sm">
          <span className="font-medium">
            {tr(`kind.${request.kind}`)}
            {request.status !== "PENDING" && (
              <Badge
                variant={
                  request.status === "APPROVED" ? "secondary" : "outline"
                }
                className="ml-2"
              >
                {tr(`status.${request.status}`)}
              </Badge>
            )}
          </span>
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
          <span className="text-muted-foreground">
            {request.status === "PENDING" || !request.reviewedAt
              ? tr("requests.sentOn", { date: dateOf(request.createdAt) })
              : tr("requests.decidedOn", {
                  status: request.status,
                  date: dateOf(request.reviewedAt),
                })}
          </span>
          {request.reviewNote && (
            <span className="text-muted-foreground">
              {tr("requests.reviewNote", { note: request.reviewNote })}
            </span>
          )}
        </div>
        {request.status === "PENDING" &&
          (mode === "admin" ? (
            <span className="flex gap-2">
              <Button
                size="sm"
                aria-label={tr("approveLabel", { summary })}
                onClick={() => setApproving(request)}
              >
                <Check aria-hidden="true" />
                {tr("approve")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                aria-label={tr("rejectLabel", { summary })}
                onClick={() => setRejecting(request)}
              >
                <X aria-hidden="true" />
                {tr("reject")}
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              aria-label={tr("withdrawLabel", { summary })}
              onClick={() => setWithdrawing(request)}
            >
              <Undo2 aria-hidden="true" />
              {tr("withdraw")}
            </Button>
          ))}
      </li>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>
            {mode === "admin"
              ? tr("requests.title")
              : tr("requests.teacherTitle")}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {mode === "admin" && (
          <p className="text-sm text-muted-foreground">
            {tr("requests.lead", { firstName })}
          </p>
        )}
        {requests.pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {tr("requests.empty")}
          </p>
        ) : (
          <ul
            className="flex flex-col divide-y"
            aria-label={tr("requests.caption")}
          >
            {requests.pending.map(item)}
          </ul>
        )}
        {mode === "teacher" && requests.recent.length > 0 && (
          <>
            <h3 className="text-sm font-medium">
              {tr("requests.recent", { days: RECENT_DECISION_DAYS })}
            </h3>
            <ul className="flex flex-col divide-y">
              {requests.recent.map(item)}
            </ul>
          </>
        )}
      </CardContent>
      {approving && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setApproving(null)}
          title={tr("approveTitle")}
          description={
            <div className="flex flex-col gap-0.5">
              {linesOf(approving).lines.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </div>
          }
          confirmLabel={tr("approve")}
          run={() => approveAvailabilityRequestAction(teacherId, approving.id)}
          onDone={(result) => {
            if (result.data.affected > 0) {
              toast.warning(
                t("savedWithImpact", { count: result.data.affected }),
                {
                  duration: 10_000,
                  action: {
                    label: t("viewInTimetable"),
                    onClick: () =>
                      router.push(`/admin/timetable?teacher=${teacherId}`),
                  },
                },
              );
            }
          }}
        />
      )}
      <FormDialog
        open={rejecting !== null}
        onOpenChange={(open) => !open && setRejecting(null)}
        title={tr("rejectTitle")}
        description={tr("rejectDescription", { firstName })}
        submitLabel={tr("reject")}
        schema={rejectSchema}
        action={(previous, formData) =>
          rejectAvailabilityRequestAction(
            teacherId,
            rejecting?.id ?? "",
            previous,
            formData,
          )
        }
      >
        <TextField name="note" label={tr("field.note")} optional />
      </FormDialog>
      {withdrawing && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setWithdrawing(null)}
          title={tr("withdrawTitle")}
          description={
            <div className="flex flex-col gap-0.5">
              {linesOf(withdrawing).lines.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </div>
          }
          confirmLabel={tr("withdraw")}
          run={() => withdrawRequestAction(withdrawing.id)}
        />
      )}
    </Card>
  );
}
