"use client";

import { cn } from "cn";
import { OctagonX, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import {
  useConflictMessage,
  useDateFormat,
} from "@/components/timetable/format";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import type { Conflict } from "@/server/scheduling";

/** Links offered next to a conflict (timetable.md §3.2). */
function FixLink({
  conflict,
  onShowSlot,
  onFocusField,
}: {
  conflict: Conflict;
  onShowSlot?: (slotId: string) => void;
  onFocusField?: (field: "group" | "room") => void;
}) {
  const t = useTranslations("timetable.check");
  const link =
    "text-xs font-medium text-primary underline-offset-4 hover:underline";
  const { refs } = conflict;
  const items: ReactNode[] = [];
  if (refs.counterpart?.kind === "slot" && onShowSlot) {
    const id = refs.counterpart.id;
    items.push(
      <button
        key="show"
        type="button"
        className={link}
        onClick={() => onShowSlot(id)}
      >
        {t("showSlot")}
      </button>,
    );
  }
  switch (conflict.type) {
    case "GROUP_ARCHIVED":
      if (onFocusField) {
        items.push(
          <button
            key="group"
            type="button"
            className={link}
            onClick={() => onFocusField("group")}
          >
            {t("chooseGroup")}
          </button>,
        );
      }
      break;
    case "ROOM_ARCHIVED":
      if (onFocusField) {
        items.push(
          <button
            key="room"
            type="button"
            className={link}
            onClick={() => onFocusField("room")}
          >
            {t("chooseRoom")}
          </button>,
        );
      }
      break;
    case "STUDENT_DOUBLE_BOOKED":
    case "GROUP_OVER_CAPACITY":
    case "ONE_ON_ONE_STUDENT_COUNT":
      if (refs.groupId) {
        items.push(
          <Link
            key="members"
            href={`/admin/groups/${refs.groupId}`}
            className={link}
            target="_blank"
          >
            {t("members")}
          </Link>,
        );
      }
      break;
    case "ROOM_CAPACITY_EXCEEDED":
      items.push(
        <Link
          key="room"
          href="/admin/settings/rooms"
          className={link}
          target="_blank"
        >
          {t("room")}
        </Link>,
      );
      break;
    case "TEACHER_UNAVAILABLE_WEEKLY":
    case "TEACHER_UNAVAILABLE_ON_DATE":
      if (refs.teacherId) {
        items.push(
          <Link
            key="availability"
            href={`/admin/teachers/${refs.teacherId}?tab=availability`}
            className={link}
            target="_blank"
          >
            {t("availability")}
          </Link>,
        );
      }
      break;
    case "OUTSIDE_SCHOOL_DAYS":
    case "OUTSIDE_SCHOOL_HOURS":
      items.push(
        <Link
          key="school"
          href="/admin/settings/school"
          className={link}
          target="_blank"
        >
          {t("schoolSettings")}
        </Link>,
      );
      break;
  }
  return items.length > 0 ? (
    <span className="flex flex-wrap gap-3">{items}</span>
  ) : null;
}

function ShowDates({ dates }: { dates: string[] }) {
  const t = useTranslations("timetable.check");
  const formatDate = useDateFormat();
  if (dates.length <= 1) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer font-medium text-primary">
        {t("showDates")}
      </summary>
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
        {dates.slice(0, 20).map((d) => (
          <li key={d}>{formatDate(d, "weekdayDate")}</li>
        ))}
        {dates.length > 20 && (
          <li>{t("moreDates", { count: dates.length - 20 })}</li>
        )}
      </ul>
    </details>
  );
}

export function SeverityIcon({ severity }: { severity: Conflict["severity"] }) {
  return severity === "blocking" ? (
    <OctagonX aria-hidden="true" className="size-4 shrink-0 text-danger" />
  ) : (
    <TriangleAlert
      aria-hidden="true"
      className="size-4 shrink-0 text-warning"
    />
  );
}

export function SeverityBadge({
  severity,
}: {
  severity: Conflict["severity"];
}) {
  const t = useTranslations("timetable.severity");
  return severity === "blocking" ? (
    <Badge className="border-danger-border bg-danger-surface text-danger">
      {t("blocking")}
    </Badge>
  ) : (
    <Badge className="border-warning-border bg-warning-surface text-warning">
      {t("warning")}
    </Badge>
  );
}

/**
 * One conflict row: icon + badge + message + fix links + "Show dates", and
 * for warnings the acknowledgement checkbox (§5.4).
 */
export function ConflictRow({
  conflict,
  acknowledge,
  isNew,
  invalid,
  onShowSlot,
  onFocusField,
}: {
  conflict: Conflict;
  acknowledge?: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    id: string;
  };
  isNew?: boolean;
  invalid?: boolean;
  onShowSlot?: (slotId: string) => void;
  onFocusField?: (field: "group" | "room") => void;
}) {
  const t = useTranslations("timetable");
  const message = useConflictMessage()(conflict);
  return (
    <li
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-3",
        conflict.severity === "blocking"
          ? "border-danger-border bg-danger-surface"
          : "border-warning-border bg-warning-surface",
      )}
    >
      <div className="flex items-start gap-2">
        <SeverityIcon severity={conflict.severity} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1">
            <SeverityBadge severity={conflict.severity} />
            {isNew && <Badge variant="outline">{t("severity.newBadge")}</Badge>}
          </span>
          <p className="text-sm">{message}</p>
          <FixLink
            conflict={conflict}
            onShowSlot={onShowSlot}
            onFocusField={onFocusField}
          />
          <ShowDates dates={conflict.dates} />
        </div>
      </div>
      {acknowledge && (
        <label className="flex items-center gap-2 pl-6 text-sm font-medium">
          <Checkbox
            id={acknowledge.id}
            checked={acknowledge.checked}
            onCheckedChange={(checked) =>
              acknowledge.onChange(checked === true)
            }
            aria-label={t("override.acknowledgeLabel", { message })}
            aria-invalid={invalid || undefined}
          />
          {t("override.acknowledge")}
        </label>
      )}
    </li>
  );
}
