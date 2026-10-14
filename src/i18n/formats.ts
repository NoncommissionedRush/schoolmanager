import type { Formats } from "next-intl";

/**
 * Named formats shared by `useFormatter()` / `getFormatter()` and ICU
 * messages (`{start, date, short}`). Prefer these over ad-hoc options so
 * dates look the same everywhere.
 */
export const formats = {
  dateTime: {
    // 14 Oct 2026
    short: { day: "numeric", month: "short", year: "numeric" },
    // Wednesday, 14 October 2026
    long: { weekday: "long", day: "numeric", month: "long", year: "numeric" },
    // 14 Oct
    dayMonth: { day: "numeric", month: "short" },
    // 09:30
    time: { hour: "2-digit", minute: "2-digit" },
    // Wed
    weekdayShort: { weekday: "short" },
    // Wednesday
    weekdayLong: { weekday: "long" },
  },
} satisfies Formats;
