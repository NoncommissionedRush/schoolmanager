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
  /** The school's other terms; the edited term is skipped by id. */
  terms?: TermRange[];
  /** Id of the term being edited; null for a new term. */
  id?: string | null;
};

type TermRange = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Term dialog (§6.8): name, first and last day, last ≥ first. In a
 * published term a changed date — old or new value — can't lie before
 * today, because past lessons are never touched (`cannotRemovePast`).
 * A school's terms never overlap (`terms.error.overlap`, data-model.md);
 * the `terms_no_overlap` constraint backs this up.
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
      const [clash] = overlappingTerms(term, context?.terms ?? [], context?.id);
      if (clash) overlapIssue(ctx, term, clash);
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

/**
 * The overlap error goes on the date that lies inside the other term (the
 * start when both do, or when the new term encloses the other one).
 */
function overlapIssue(
  ctx: z.RefinementCtx,
  term: { startDate: string; endDate: string },
  clash: TermRange,
) {
  const inside = (date: string) =>
    clash.startDate <= date && date <= clash.endDate;
  const field =
    !inside(term.startDate) && inside(term.endDate) ? "endDate" : "startDate";
  issue(ctx, field, "terms.error.overlap", { term: clash.name });
}

/** Terms whose dates overlap `range`; both first and last day count. */
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
