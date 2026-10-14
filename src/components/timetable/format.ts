import {
  type DateTimeFormatOptions,
  useFormatter,
  useTranslations,
} from "next-intl";
import { useCallback } from "react";

import type { Conflict } from "@/server/scheduling";

export { formatMinutes } from "@/server/scheduling";

/** A calendar date as a `Date` at UTC midnight, to format with `timeZone: "UTC"`. */
export function calendarDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** Formats calendar dates ("YYYY-MM-DD") without shifting them by time zone. */
export function useDateFormat() {
  const format = useFormatter();
  return useCallback(
    (
      date: string,
      style:
        "short" | "long" | "dayMonth" | "weekdayDate" | "weekdayLong" = "short",
    ) => {
      const options: DateTimeFormatOptions =
        style === "long"
          ? { weekday: "long", day: "numeric", month: "long", year: "numeric" }
          : style === "dayMonth"
            ? { day: "numeric", month: "short" }
            : style === "weekdayDate"
              ? {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                }
              : style === "weekdayLong"
                ? { weekday: "long", day: "numeric", month: "long" }
                : { day: "numeric", month: "short", year: "numeric" };
      return format.dateTime(calendarDate(date), {
        ...options,
        timeZone: "UTC",
      });
    },
    [format],
  );
}

type RawTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/**
 * Renders a conflict's message from `scheduling.conflicts.<TYPE>`, with
 * dates reformatted for display (timetable.md §3.2). Unknown types fall back
 * to a generic message so a module update never breaks the UI.
 */
export function useConflictMessage() {
  const t = useTranslations() as unknown as RawTranslate & {
    has: (key: string) => boolean;
  };
  const formatDate = useDateFormat();
  return useCallback(
    (conflict: Conflict) => {
      const key = `scheduling.conflicts.${conflict.type}`;
      if (!t.has(key)) return t("timetable.conflict.generic");
      const values: Record<string, string | number> = { ...conflict.params };
      for (const name of ["firstDate", "termStart", "termEnd"]) {
        const value = values[name];
        if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
          values[name] = formatDate(value, "weekdayDate");
        }
      }
      return t(key, values);
    },
    [t, formatDate],
  );
}
