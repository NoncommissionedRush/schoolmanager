"use client";

import { Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
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
  deleteAvailabilityAction,
  saveExceptionAction,
  saveWeeklyAction,
} from "../actions";

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

type Props = {
  teacherId: string;
  name: string;
  teachingWeekdays: number[];
  weekly: WeeklyRule[];
  exceptions: Exception[];
};

/** Availability tab (§6.4): weekly unavailability + one-off exceptions. */
export function AvailabilityTab(props: Props) {
  const t = useTranslations("availability");
  const firstName = props.name.split(/\s+/)[0];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t("lead", { firstName })}
      </p>
      <WeeklyCard {...props} firstName={firstName} />
      <ExceptionsCard {...props} />
    </div>
  );
}

function WeeklyCard({
  teacherId,
  name,
  firstName,
  teachingWeekdays,
  weekly,
}: Props & { firstName: string }) {
  const t = useTranslations("availability");
  const tc = useTranslations("common");
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
            {t("weekly.empty", { firstName })}
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
                </span>
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
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing === "new" ? t("weekly.addTitle") : t("weekly.editTitle")}
        submitLabel={t("save")}
        schema={weeklySchema}
        action={(previous, formData) =>
          saveWeeklyAction(
            teacherId,
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
          title={t("weekly.deleteTitle", labelOf(deleting))}
          description={tc("confirm.irreversible")}
          confirmLabel={tc("delete")}
          destructive
          run={() => deleteAvailabilityAction(teacherId, deleting.id)}
        />
      )}
    </Card>
  );
}

function ExceptionsCard({ teacherId, name, weekly, exceptions }: Props) {
  const t = useTranslations("availability");
  const tc = useTranslations("common");
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <ExceptionDialog
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
          title={t("exceptions.deleteTitle", {
            date: formatDate(deleting.date),
          })}
          description={tc("confirm.irreversible")}
          confirmLabel={tc("delete")}
          destructive
          run={() => deleteAvailabilityAction(teacherId, deleting.id)}
        />
      )}
    </Card>
  );
}

function ExceptionDialog({
  teacherId,
  weekly,
  open,
  onOpenChange,
  onImpact,
}: {
  teacherId: string;
  weekly: WeeklyRule[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImpact: (count: number) => void;
}) {
  const t = useTranslations("availability");
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
      submitLabel={t("save")}
      schema={exceptionSchema}
      action={(previous, formData) =>
        saveExceptionAction(teacherId, previous, formData)
      }
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
