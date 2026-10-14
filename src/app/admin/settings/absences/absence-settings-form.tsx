"use client";

import { Info } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";

import { AdminForm, SubmitButton, useFormState } from "@/components/admin/form";
import { useMessage } from "@/components/admin/use-message";
import { useDateFormat } from "@/components/timetable/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { absenceSettingsSchema } from "@/server/admin/absence-settings/schema";
import { addDays } from "@/server/scheduling/time";

import { saveAbsenceSettingsAction } from "./actions";

/** A whole-number input inside a sentence (§7.1), with its own error line. */
function SentenceNumber({
  name,
  label,
  value,
  onChange,
  min,
  max,
  before,
  after,
  describedBy,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  before: string;
  after: string;
  describedBy: string;
}) {
  const id = useId();
  const render = useMessage();
  const { errors, validateField } = useFormState();
  const error = errors[name] ? render(errors[name]) : null;
  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span>{before}</span>
        <Input
          id={id}
          name={name}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => validateField(name)}
          aria-label={label}
          aria-invalid={!!error}
          aria-describedby={[error ? `${id}-error` : null, describedBy]
            .filter(Boolean)
            .join(" ")}
          className="w-20 tabular-nums"
        />
        <span>{after}</span>
      </p>
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function AbsenceSettingsForm({
  settings,
  example,
}: {
  settings: { cutoffHours: number; validDays: number; updatedAt: string };
  example: { lessonDate: string; lessonStartsAt: string };
}) {
  const t = useTranslations("settings.absences");
  const render = useMessage();
  const format = useFormatter();
  const formatDate = useDateFormat();
  const [hours, setHours] = useState(String(settings.cutoffHours));
  const [days, setDays] = useState(String(settings.validDays));
  const cutoffExampleId = useId();
  const validityExampleId = useId();

  const whole = (value: string, min: number, max: number) => {
    const n = Number(value);
    return value.trim() !== "" && Number.isInteger(n) && n >= min && n <= max
      ? n
      : null;
  };
  const h = whole(hours, 0, 336);
  const d = whole(days, 1, 365);
  const lessonStart = new Date(example.lessonStartsAt);
  const dateTime = (instant: Date) =>
    format.dateTime(instant, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <Card>
      <CardContent>
        <AdminForm
          action={saveAbsenceSettingsAction}
          schema={absenceSettingsSchema}
          onSuccess={(result) => {
            if (result.message) toast.success(render(result.message));
          }}
          footer={(pending) => (
            <div className="flex justify-end">
              <SubmitButton pending={pending}>{t("save")}</SubmitButton>
            </div>
          )}
        >
          <input type="hidden" name="updatedAt" value={settings.updatedAt} />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t("cutoff")}</legend>
            <SentenceNumber
              name="cutoffHours"
              label={t("cutoffLabel")}
              value={hours}
              onChange={setHours}
              min={0}
              max={336}
              before={t("cutoffBefore")}
              after={t("cutoffAfter")}
              describedBy={cutoffExampleId}
            />
            <p
              id={cutoffExampleId}
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >
              {h === null
                ? null
                : h === 0
                  ? t("cutoffZero")
                  : t("cutoffExample", {
                      lessonDateTime: dateTime(lessonStart),
                      cutoffDateTime: dateTime(
                        new Date(lessonStart.getTime() - h * 3_600_000),
                      ),
                    })}
            </p>
            <p className="text-xs text-muted-foreground">{t("cutoffHint")}</p>
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">
              {t("validity")}
            </legend>
            <SentenceNumber
              name="validDays"
              label={t("validityLabel")}
              value={days}
              onChange={setDays}
              min={1}
              max={365}
              before={t("validityBefore")}
              after={t("validityAfter")}
              describedBy={validityExampleId}
            />
            <p
              id={validityExampleId}
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >
              {d === null
                ? null
                : t("validityExample", {
                    lessonDate: formatDate(example.lessonDate, "weekdayDate"),
                    expiryDate: formatDate(
                      addDays(example.lessonDate, d),
                      "weekdayDate",
                    ),
                  })}
            </p>
          </fieldset>
          <Alert>
            <Info aria-hidden="true" />
            <AlertDescription>{t("appliesToNew")}</AlertDescription>
          </Alert>
        </AdminForm>
      </CardContent>
    </Card>
  );
}
