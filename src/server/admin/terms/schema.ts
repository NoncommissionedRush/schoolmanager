import { z } from "zod";

import { isoDate, issue, requiredText } from "../validation";

/** What the term dialog needs to know about the term being edited. */
export type TermContext = {
  /** The term's timetable is published (lessons exist). */
  published: boolean;
  /** Stored dates, `YYYY-MM-DD`; null for a new term. */
  original: { startDate: string; endDate: string } | null;
  /** Today in the school's time zone, `YYYY-MM-DD`. */
  today: string;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Term dialog (§6.8): name, first and last day, last ≥ first. In a
 * published term a changed date — old or new value — can't lie before
 * today, because past lessons are never touched (`cannotRemovePast`).
 */
export function termSchema(context?: TermContext) {
  return z
    .object({
      name: requiredText({ max: 60 }),
      startDate: isoDate(),
      endDate: isoDate(),
    })
    .superRefine((term, ctx) => {
      if (!ISO.test(term.startDate) || !ISO.test(term.endDate)) return;
      if (term.endDate < term.startDate) {
        issue(ctx, "endDate", "terms.error.endBeforeStart");
        return;
      }
      for (const field of pastDateViolations(term, context)) {
        issue(ctx, field, "terms.error.cannotRemovePast");
      }
    });
}

export type TermInput = z.output<ReturnType<typeof termSchema>>;

/** Date fields of a published term moved before (or away from) the past. */
export function pastDateViolations(
  next: { startDate: string; endDate: string },
  context: TermContext | undefined,
): ("startDate" | "endDate")[] {
  if (!context?.published || !context.original) return [];
  const { original, today } = context;
  return (["startDate", "endDate"] as const).filter(
    (field) =>
      next[field] !== original[field] &&
      (next[field] < today || original[field] < today),
  );
}

/** Whether a published term's dates changed (lessons must be regenerated). */
export function datesChanged(
  next: { startDate: string; endDate: string },
  original: { startDate: string; endDate: string },
): boolean {
  return (
    next.startDate !== original.startDate || next.endDate !== original.endDate
  );
}

/** Terms whose dates overlap `range` (inclusive) — a warning, not an error. */
export function overlappingTerms<T extends { id: string; name: string }>(
  range: { startDate: string; endDate: string },
  terms: (T & { startDate: string; endDate: string })[],
  exceptId?: string | null,
): T[] {
  return terms.filter(
    (term) =>
      term.id !== exceptId &&
      term.startDate <= range.endDate &&
      term.endDate >= range.startDate,
  );
}

/** "Current" badge: today within the term's dates. */
export function isCurrentTerm(
  term: { startDate: string; endDate: string },
  today: string,
): boolean {
  return term.startDate <= today && today <= term.endDate;
}
