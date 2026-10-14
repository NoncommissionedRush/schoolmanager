import { z } from "zod";

import { id, isoDate, issue, requiredText } from "../validation";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Holiday dialog (§6.8): name, first and last day (inclusive; a single day
 * is the same date twice) and what it applies to — every term
 * (school-wide, `termId` null) or one term.
 */
export const holidaySchema = z
  .object({
    name: requiredText({ max: 80 }),
    startDate: isoDate(),
    endDate: isoDate(),
    scope: z.enum(["school", "term"]),
    termId: z.unknown().optional(),
  })
  .superRefine((holiday, ctx) => {
    if (
      ISO.test(holiday.startDate) &&
      ISO.test(holiday.endDate) &&
      holiday.endDate < holiday.startDate
    ) {
      issue(ctx, "endDate", "terms.error.endBeforeStart");
    }
    if (
      holiday.scope === "term" &&
      !id("holidays.field.term").safeParse(holiday.termId).success
    ) {
      issue(ctx, "termId", "validation.select", {
        field: { key: "holidays.field.term" },
      });
    }
  })
  .transform(({ name, startDate, endDate, scope, termId }) => ({
    name,
    startDate,
    endDate,
    termId: scope === "term" ? String(termId).trim() : null,
  }));

export type HolidayFormInput = z.output<typeof holidaySchema>;

type TermDates = {
  id: string;
  startDate: string;
  endDate: string;
  published: boolean;
};

/**
 * Published terms a holiday touches: its own term, or every term it
 * overlaps when school-wide (same rule as the timetable service). A
 * non-empty result means lessons change, so the dialog states the rule.
 */
export function touchedPublishedTerms(
  holiday: { termId: string | null; startDate: string; endDate: string },
  terms: TermDates[],
): string[] {
  return terms
    .filter(
      (term) =>
        term.published &&
        (holiday.termId
          ? term.id === holiday.termId
          : term.startDate <= holiday.endDate &&
            term.endDate >= holiday.startDate),
    )
    .map((term) => term.id);
}

/** A term holiday that lies (partly) outside its term's dates (§9). */
export function isOutsideTerm(
  holiday: { startDate: string; endDate: string },
  term: { startDate: string; endDate: string } | null,
): boolean {
  if (!term) return false;
  return holiday.startDate < term.startDate || holiday.endDate > term.endDate;
}
