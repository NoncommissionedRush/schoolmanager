"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useCallback } from "react";

import { calendarDate } from "@/components/timetable/format";
import type { SubstituteReason } from "@/server/scheduling/substitutes";

/** "7.5 h" from minutes. */
export function useHours() {
  const t = useTranslations("substitutes.reason");
  const format = useFormatter();
  return useCallback(
    (minutes: number) =>
      t("hoursValue", {
        hours: format.number(minutes / 60, { maximumFractionDigits: 1 }),
      }),
    [t, format],
  );
}

/** A substitute reason as one sentence (design §5.3: every reason is text). */
export function useReasonText() {
  const t = useTranslations("substitutes.reason");
  const format = useFormatter();
  const hours = useHours();
  return useCallback(
    (reason: SubstituteReason): string => {
      const p = reason.params;
      switch (reason.code) {
        case "BUSY":
          return t("busy", {
            otherGroup: String(p.otherGroup ?? ""),
            otherTime: String(p.otherTime ?? ""),
          });
        case "UNAVAILABLE_WEEKLY":
          return t("unavailableWeekly", {
            weekday: String(p.weekday ?? ""),
            allDay: String(p.allDay ?? "no"),
            time: String(p.time ?? ""),
          });
        case "UNAVAILABLE_ON_DATE":
          return t("unavailableDate", {
            date: p.date
              ? format.dateTime(calendarDate(String(p.date)), {
                  day: "numeric",
                  month: "short",
                  timeZone: "UTC",
                })
              : "",
            allDay: String(p.allDay ?? "no"),
            time: String(p.time ?? ""),
          });
        case "LEVEL_NOT_TAUGHT":
          return t("notLevel", {
            level: String(p.level ?? ""),
            levels: p.levels ? String(p.levels) : "none",
          });
        case "OVER_MAX_HOURS":
          return t("overMax", {
            current: hours(Number(p.current)),
            with: hours(Number(p.with)),
            max: hours(Number(p.max)),
          });
        case "ARCHIVED":
        case "IS_CURRENT":
        case "IS_REGULAR_TEACHER":
          return t("archived");
      }
    },
    [t, format, hours],
  );
}
