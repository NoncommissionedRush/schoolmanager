"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

import { formatMinutes, useDateFormat } from "@/components/timetable/format";
import type { ReasonView } from "@/server/replacements/booking";

/**
 * Renders a replacement reason (`replacements.reasons.<CODE>`, replacements.md
 * §6) with its names and local times, e.g. "Room full (15/14)".
 */
export function useReasonText() {
  const t = useTranslations("replacements.reasons");
  const formatDate = useDateFormat();
  return useCallback(
    (reason: ReasonView) => {
      switch (reason.code) {
        case "ROOM_FULL":
          return t("ROOM_FULL", {
            taken: reason.taken ?? 0,
            capacity: reason.capacity ?? 0,
          });
        case "LEVEL_MISMATCH":
          return t("LEVEL_MISMATCH", { level: reason.level ?? "" });
        case "CREDIT_EXPIRES_FIRST":
          return t("CREDIT_EXPIRES_FIRST", {
            date: reason.validUntil
              ? formatDate(reason.validUntil, "dayMonth")
              : "",
          });
        case "STUDENT_CLASH":
          return reason.clash
            ? t("STUDENT_CLASH", {
                lesson: `${reason.clash.group}, ${formatDate(reason.clash.date, "dayMonth")} ${formatMinutes(reason.clash.startMinute)}`,
              })
            : t("STUDENT_CLASH_UNKNOWN");
        default:
          return t(reason.code);
      }
    },
    [t, formatDate],
  );
}
