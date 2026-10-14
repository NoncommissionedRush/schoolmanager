import { fromIsoDate, toIsoDate } from "@/server/scheduling";
import {
  deleteTerm as deleteTermWithSlots,
  regenerateLessons,
} from "@/server/timetable/service";

import { AdminError, msg } from "../result";
import {
  audit,
  isExclusionViolation,
  isUniqueViolation,
  notFound,
  type SchoolDb,
  type Scope,
  uniqueError,
} from "../shared";
import type { LessonChanges } from "./lesson-result";
import {
  datesChanged,
  isCurrentTerm,
  type TermContext,
  type TermInput,
} from "./schema";

const TERMS_NO_OVERLAP = "terms_no_overlap";

/** Terms table (§6.8), oldest first. Dates as `YYYY-MM-DD`. */
export async function listTerms(db: SchoolDb, today: string) {
  const terms = await db.term.findMany({
    orderBy: [{ startDate: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      timetablePublishedAt: true,
      _count: {
        select: { timetableSlots: true, holidays: true, lessons: true },
      },
    },
  });
  return terms.map(({ _count, startDate, endDate, ...term }) => {
    const dates = {
      startDate: toIsoDate(startDate),
      endDate: toIsoDate(endDate),
    };
    return {
      id: term.id,
      name: term.name,
      ...dates,
      published: !!term.timetablePublishedAt,
      current: isCurrentTerm(dates, today),
      slots: _count.timetableSlots,
      holidays: _count.holidays,
      lessons: _count.lessons,
    };
  });
}

/** What `termSchema` needs to validate an edit of `id` (or a new term). */
export async function termContext(
  db: SchoolDb,
  id: string | null,
  today: string,
): Promise<TermContext> {
  const terms = (
    await db.term.findMany({
      select: { id: true, name: true, startDate: true, endDate: true },
    })
  ).map((term) => ({
    ...term,
    startDate: toIsoDate(term.startDate),
    endDate: toIsoDate(term.endDate),
  }));
  if (!id) return { published: false, original: null, today, terms, id };
  const term = await findTerm(db, id);
  return {
    published: !!term.timetablePublishedAt,
    original: {
      startDate: toIsoDate(term.startDate),
      endDate: toIsoDate(term.endDate),
    },
    today,
    terms,
    id,
  };
}

async function findTerm(db: SchoolDb, id: string) {
  const term = await db.term.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      timetablePublishedAt: true,
    },
  });
  if (!term) throw notFound();
  return term;
}

async function assertNameFree(db: SchoolDb, name: string, exceptId?: string) {
  const clash = await db.term.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw uniqueError("name", "terms.field.name", name);
}

/**
 * `terms_no_overlap` refused the dates: another save got in between the
 * schema check and this one. Reported like the schema's overlap error.
 */
async function overlapError(db: SchoolDb, input: TermInput, exceptId?: string) {
  const clash = await db.term.findFirst({
    where: {
      startDate: { lte: fromIsoDate(input.endDate) },
      endDate: { gte: fromIsoDate(input.startDate) },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { name: true },
  });
  return new AdminError(
    clash
      ? msg("terms.error.overlap", { term: clash.name })
      : msg("terms.error.overlapAny"),
    "startDate",
  );
}

const toData = (input: TermInput) => ({
  name: input.name,
  startDate: fromIsoDate(input.startDate),
  endDate: fromIsoDate(input.endDate),
});

export async function createTerm(scope: Scope, input: TermInput) {
  const { db, schoolId } = scope;
  await assertNameFree(db, input.name);
  try {
    const term = await db.term.create({
      data: { ...toData(input), schoolId },
      select: { id: true, name: true },
    });
    await audit(scope, "term.created", "Term", term.id, {
      startDate: input.startDate,
      endDate: input.endDate,
    });
    return { ...term, lessons: null };
  } catch (error) {
    if (isUniqueViolation(error))
      throw uniqueError("name", "terms.field.name", input.name);
    if (isExclusionViolation(error, TERMS_NO_OVERLAP))
      throw await overlapError(db, input);
    throw error;
  }
}

/**
 * Saves a term. When a published term's dates change, its lessons are
 * reconciled with `regenerateLessons` (scheduling.md) and the counts
 * returned for the result toast. The caller validated the input with the
 * term's `termContext` (published-term date rule).
 */
export async function updateTerm(
  scope: Scope,
  id: string,
  input: TermInput,
): Promise<{
  id: string;
  name: string;
  lessons: LessonChanges | null;
}> {
  const { db, actor } = scope;
  const before = await findTerm(db, id);
  await assertNameFree(db, input.name, id);
  try {
    await db.term.update({ where: { id }, data: toData(input) });
  } catch (error) {
    if (isUniqueViolation(error))
      throw uniqueError("name", "terms.field.name", input.name);
    if (isExclusionViolation(error, TERMS_NO_OVERLAP))
      throw await overlapError(db, input, id);
    throw error;
  }
  const original = {
    startDate: toIsoDate(before.startDate),
    endDate: toIsoDate(before.endDate),
  };
  await audit(scope, "term.updated", "Term", id, {
    before: original,
    after: { startDate: input.startDate, endDate: input.endDate },
  });
  const lessons =
    before.timetablePublishedAt && datesChanged(input, original)
      ? await regenerateLessons(db, actor, id)
      : null;
  return { id, name: input.name, lessons };
}

/**
 * Deletes a term with its slots and own holidays via the timetable service,
 * which refuses (`TERM_HAS_LESSONS`) once lessons exist.
 */
export async function deleteTerm(scope: Scope, id: string) {
  const term = await findTerm(scope.db, id);
  await deleteTermWithSlots(scope.db, scope.actor, id);
  return term;
}
