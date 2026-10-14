import { z } from "zod";

import {
  encodeMessage,
  issue,
  list,
  requiredText,
  timeOfDay,
} from "../validation";

/** Whether `name` is an IANA time zone this runtime knows. */
export function isTimeZone(name: string): boolean {
  if (!name) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** IANA zones for the picker; `current` is kept even if unlisted. */
export function timeZoneOptions(current: string): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes(current) ? zones : [current, ...zones].sort();
}

const weekday = z.coerce
  .number({ error: encodeMessage("common.error.unexpected") })
  .int({ error: encodeMessage("common.error.unexpected") })
  .min(1, { error: encodeMessage("common.error.unexpected") })
  .max(7, { error: encodeMessage("common.error.unexpected") });

/**
 * Settings › School (§6.11): name, time zone, school days (ISO weekdays,
 * at least one) and school hours (from < to, minutes since midnight).
 */
export const schoolSettingsSchema = z
  .object({
    name: requiredText({ max: 100 }),
    timezone: z.preprocess(
      (value) => (typeof value === "string" ? value.trim() : ""),
      z.string().refine(isTimeZone, {
        error: encodeMessage("settings.school.error.timezone"),
      }),
    ),
    teachingWeekdays: list(weekday).refine((days) => days.length > 0, {
      error: encodeMessage("settings.school.error.noDays"),
    }),
    dayStartMinute: timeOfDay(),
    dayEndMinute: timeOfDay(),
  })
  .superRefine((school, ctx) => {
    if (school.dayEndMinute <= school.dayStartMinute) {
      issue(ctx, "dayEndMinute", "validation.timeOrder");
    }
  })
  .transform((school) => ({
    ...school,
    teachingWeekdays: [...new Set(school.teachingWeekdays)].sort(
      (a, b) => a - b,
    ),
  }));

export type SchoolSettingsInput = z.output<typeof schoolSettingsSchema>;
