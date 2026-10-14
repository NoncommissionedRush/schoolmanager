import { z } from "zod";

import {
  checkbox,
  encodeMessage,
  isoDate,
  issue,
  list,
  optionalText,
  timeOfDay,
} from "../validation";
import { expandDateRange } from "./rules";

/**
 * Availability dialogs (§6.4). Shared by the client (validate on blur and
 * submit) and the server actions.
 */

const weekday = z.preprocess(
  (value) => Number(value),
  z
    .number()
    .int()
    .min(1)
    .max(7, { error: encodeMessage("common.error.unexpected") }),
);

/** Weekly unavailability: one row per checked weekday. */
export const weeklySchema = z
  .object({
    weekdays: list(weekday).refine((days) => days.length > 0, {
      error: encodeMessage("validation.select", {
        field: { key: "availability.field.weekdays" },
      }),
    }),
    from: timeOfDay(),
    to: timeOfDay(),
    note: optionalText({ max: 200 }),
  })
  .superRefine((rule, ctx) => {
    if (rule.from >= rule.to) issue(ctx, "to", "validation.timeOrder");
  })
  .transform(({ weekdays, from, to, note }) => ({
    weekdays: [...new Set(weekdays)].sort(),
    startMinute: from,
    endMinute: to,
    note,
  }));

const optionalDate = () =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : null),
    isoDate().nullable(),
  );

/** Time when "Whole day" is off; ignored otherwise. */
const optionalTime = () =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : null),
    timeOfDay().nullable(),
  );

/** One-off exception, optionally a date range (one row per day, ≤ 31). */
export const exceptionSchema = z
  .object({
    kind: z.enum(["DATE_UNAVAILABLE", "DATE_AVAILABLE"]),
    date: isoDate(),
    dateTo: optionalDate(),
    wholeDay: checkbox(),
    from: optionalTime(),
    to: optionalTime(),
    note: optionalText({ max: 200 }),
  })
  .superRefine((exception, ctx) => {
    if (exception.dateTo && exception.dateTo < exception.date) {
      issue(ctx, "dateTo", "validation.dateOrder");
    } else if (!expandDateRange(exception.date, exception.dateTo)) {
      issue(ctx, "dateTo", "availability.error.rangeTooLong");
    }
    if (!exception.wholeDay) {
      if (exception.from === null) {
        issue(ctx, "from", "validation.requiredField");
      }
      if (exception.to === null) issue(ctx, "to", "validation.requiredField");
      if (
        exception.from !== null &&
        exception.to !== null &&
        exception.from >= exception.to
      ) {
        issue(ctx, "to", "validation.timeOrder");
      }
    }
  })
  .transform(({ kind, date, dateTo, wholeDay, from, to, note }) => ({
    kind,
    dates: expandDateRange(date, dateTo) ?? [],
    window:
      wholeDay || from === null || to === null
        ? null
        : { startMinute: from, endMinute: to },
    note,
  }));

export type WeeklyInput = z.output<typeof weeklySchema>;
export type ExceptionInput = z.output<typeof exceptionSchema>;
