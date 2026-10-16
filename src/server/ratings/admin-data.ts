// The admin ratings queries (phase5-rules.md §4.3): every rating of the
// school with the author's name, per teacher and term. ADMIN ONLY. Callers
// go through `admin.ts`, which checks the role first; the import guard in
// ratings.test.ts allows importing this file only from src/app/admin/** and
// src/server/ratings/**.

import { AdminError, msg } from "@/server/admin/result";
import { isUuid } from "@/server/lessons/access";
import { toZonedDateTime } from "@/server/scheduling";
import type { SchoolDb } from "@/server/timetable/service";

import { loadPublishedTerms, loadTeachers, type TermRow } from "./data";
import { ratingOpensAt, type RatingSummary, summarizeRatings } from "./rules";

/** Ratings per page on the teacher detail page (design §6.5). */
export const RATINGS_PAGE = 20;
const RATINGS_MAX_SHOWN = 1_000;

export type AdminTerm = { id: string; name: string; opensAt: Date };

export type RatingsOverviewRow = {
  teacherId: string;
  name: string;
  archived: boolean;
  summary: RatingSummary;
};

export type RatingsOverview = {
  terms: AdminTerm[];
  /** The selected term; null when the school has no published term. */
  term: AdminTerm | null;
  rows: RatingsOverviewRow[];
};

/** `?shown=` → how many ratings to list, a multiple of the page size. */
export function parseShown(value: string | undefined): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n) || n < RATINGS_PAGE) return RATINGS_PAGE;
  return Math.min(
    Math.ceil(n / RATINGS_PAGE) * RATINGS_PAGE,
    RATINGS_MAX_SHOWN,
  );
}

/**
 * The selected term: `termId` if it is a published term, else the one
 * running today, else the latest that has started, else the first.
 */
export function pickTerm(
  terms: readonly TermRow[],
  termId: string | undefined,
  today: string,
): TermRow | null {
  return (
    terms.find((t) => t.id === termId) ??
    terms.find((t) => t.startDate <= today && today <= t.endDate) ??
    terms.filter((t) => t.startDate <= today).at(-1) ??
    terms[0] ??
    null
  );
}

async function termsFor(db: SchoolDb, termId: string | undefined, now: Date) {
  const school = await db.school.findFirstOrThrow({
    select: { timezone: true },
  });
  const terms = await loadPublishedTerms(db);
  const today = toZonedDateTime(now, school.timezone).date;
  const toAdmin = (t: TermRow): AdminTerm => ({
    id: t.id,
    name: t.name,
    opensAt: ratingOpensAt(t, school.timezone),
  });
  const term = pickTerm(terms, termId, today);
  return {
    terms: [...terms].reverse().map(toAdmin),
    term: term && toAdmin(term),
  };
}

/** _Ratings_ (design §6.5): every teacher with their summary for a term. */
export async function loadRatingsOverview(
  db: SchoolDb,
  termId: string | undefined,
  now: Date,
): Promise<RatingsOverview> {
  const { terms, term } = await termsFor(db, termId, now);
  if (!term) return { terms, term: null, rows: [] };
  const [teachers, ratings] = await Promise.all([
    loadTeachers(db),
    db.teacherRating.findMany({
      where: { termId: term.id },
      select: {
        teacherId: true,
        score: true,
        hiddenAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);
  const byTeacher = new Map<string, typeof ratings>();
  for (const r of ratings) {
    byTeacher.set(r.teacherId, [...(byTeacher.get(r.teacherId) ?? []), r]);
  }
  const rows: RatingsOverviewRow[] = [];
  for (const teacher of teachers.values()) {
    const own = byTeacher.get(teacher.id) ?? [];
    // Archived teachers stay listed for terms they had ratings in.
    if (!teacher.active && own.length === 0) continue;
    rows.push({
      teacherId: teacher.id,
      name: teacher.name,
      archived: !teacher.active,
      summary: summarizeRatings(own),
    });
  }
  rows.sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.teacherId.localeCompare(b.teacherId),
  );
  return { terms, term, rows };
}

export type AdminRating = {
  id: string;
  score: number;
  comment: string | null;
  studentName: string;
  /** The student's groups the teacher taught in this term. */
  groups: string[];
  createdAt: Date;
  /** Changed by the student after it was first saved. */
  edited: boolean;
};

export type HiddenRating = AdminRating & {
  hiddenAt: Date;
  hiddenByName: string | null;
};

export type TeacherRatingsDetail = {
  teacher: { id: string; name: string; archived: boolean };
  terms: AdminTerm[];
  term: AdminTerm | null;
  summary: RatingSummary;
  /** Groups to filter by. */
  groups: { id: string; name: string }[];
  groupId: string | null;
  visible: AdminRating[];
  hasMore: boolean;
  hidden: HiddenRating[];
};

/**
 * One teacher's ratings for a term, newest first, with the authors' names
 * (owner decision 2). Null (→ 404) for an unknown teacher.
 */
export async function loadTeacherRatings(
  db: SchoolDb,
  teacherId: string,
  filters: { termId?: string; groupId?: string; shown: number },
  now: Date,
): Promise<TeacherRatingsDetail | null> {
  if (!isUuid(teacherId)) return null;
  const teacher = (await loadTeachers(db, [teacherId])).get(teacherId);
  if (!teacher) return null;
  const { terms, term } = await termsFor(db, filters.termId, now);
  const base = {
    teacher: { id: teacher.id, name: teacher.name, archived: !teacher.active },
    terms,
    term,
  };
  if (!term) {
    return {
      ...base,
      summary: summarizeRatings([]),
      groups: [],
      groupId: null,
      visible: [],
      hasMore: false,
      hidden: [],
    };
  }

  const [ratings, lessonGroups] = await Promise.all([
    db.teacherRating.findMany({
      where: { teacherId, termId: term.id },
      select: {
        id: true,
        studentId: true,
        score: true,
        comment: true,
        hiddenAt: true,
        createdAt: true,
        updatedAt: true,
        student: { select: { user: { select: { name: true } } } },
        hiddenBy: { select: { name: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    db.lesson.findMany({
      where: {
        termId: term.id,
        OR: [{ teacherId }, { substituteTeacherId: teacherId }],
      },
      distinct: ["groupId"],
      select: { groupId: true, group: { select: { name: true } } },
    }),
  ]);
  const groupNames = new Map(
    lessonGroups.map((l) => [l.groupId, l.group.name]),
  );
  const memberships = await db.groupMembership.findMany({
    where: {
      groupId: { in: [...groupNames.keys()] },
      studentId: { in: [...new Set(ratings.map((r) => r.studentId))] },
    },
    select: { groupId: true, studentId: true },
  });
  const groupsOf = new Map<string, string[]>();
  for (const m of memberships) {
    groupsOf.set(m.studentId, [
      ...(groupsOf.get(m.studentId) ?? []),
      m.groupId,
    ]);
  }
  const groupId =
    filters.groupId && groupNames.has(filters.groupId) ? filters.groupId : null;

  const toRating = (r: (typeof ratings)[number]): AdminRating => ({
    id: r.id,
    score: r.score,
    comment: r.comment,
    studentName: r.student.user.name,
    groups: (groupsOf.get(r.studentId) ?? [])
      .map((id) => groupNames.get(id)!)
      .sort(),
    createdAt: r.createdAt,
    edited: r.updatedAt.getTime() > r.createdAt.getTime(),
  });
  const inGroup = (r: (typeof ratings)[number]) =>
    !groupId || (groupsOf.get(r.studentId) ?? []).includes(groupId);

  const visible = ratings.filter((r) => !r.hiddenAt && inGroup(r));
  return {
    ...base,
    summary: summarizeRatings(ratings),
    groups: [...groupNames]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    groupId,
    visible: visible.slice(0, filters.shown).map(toRating),
    hasMore: visible.length > filters.shown,
    hidden: ratings
      .filter((r) => r.hiddenAt && inGroup(r))
      .map((r) => ({
        ...toRating(r),
        hiddenAt: r.hiddenAt!,
        hiddenByName: r.hiddenBy?.name ?? null,
      })),
  };
}

/**
 * Hides or unhides a rating (§4.2). Admins can't edit a rating, so only the
 * hidden fields change (`updatedAt` keeps the student's last change).
 * Returns false when the rating was already in that state.
 */
export async function setRatingHidden(
  db: SchoolDb,
  actor: { userId: string },
  input: { ratingId: string; hidden: boolean },
  now: Date,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const rating = await tx.teacherRating.findFirst({
      where: { id: input.ratingId },
      select: { id: true, schoolId: true, updatedAt: true, hiddenAt: true },
    });
    if (!rating) throw new AdminError(msg("common.error.notFound"));
    const { count } = await tx.teacherRating.updateMany({
      where: {
        id: rating.id,
        hiddenAt: input.hidden ? null : { not: null },
      },
      data: input.hidden
        ? {
            hiddenAt: now,
            hiddenById: actor.userId,
            updatedAt: rating.updatedAt,
          }
        : { hiddenAt: null, hiddenById: null, updatedAt: rating.updatedAt },
    });
    if (count !== 1) return false;
    await tx.auditLog.create({
      data: {
        schoolId: rating.schoolId,
        actorId: actor.userId,
        action: input.hidden ? "rating.hidden" : "rating.unhidden",
        entityType: "TeacherRating",
        entityId: rating.id,
        data: { ratingId: rating.id },
      },
    });
    return true;
  });
}
