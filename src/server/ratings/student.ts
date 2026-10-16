// Ratings as the student sees them (phase5-rules.md §4.2–§4.4): their own
// ratings only, through a student DTO. Every query is limited to the
// viewer's `StudentProfile`; another student's rating, a teacher they can't
// rate or a guessed id is "not found". No aggregates, no other students.

import type { z } from "zod";

import { AdminError, msg } from "@/server/admin/result";
import { isUuid } from "@/server/lessons/access";
import { zonedTimeToUtc } from "@/server/scheduling";
import type { SchoolDb, Tx } from "@/server/timetable/service";

import {
  loadEndedLessons,
  loadPublishedTerms,
  loadStudentFacts,
  loadTeachers,
  type RatingLessonRow,
  type StudentFacts,
  type TermRow,
} from "./data";
import {
  attendedByTermAndTeacher,
  canRate,
  type CanRateResult,
  ratingCardState,
  type RatingCardState,
  ratingWindow,
} from "./rules";
import type { saveRatingSchema } from "./schema";

/** The student's own rating: what they wrote, never an id or aggregate. */
export type OwnRating = {
  score: number;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RatingCard = {
  teacherId: string;
  teacherName: string;
  /** Never the regular teacher of an attended lesson: "(substitute)". */
  substitute: boolean;
  /** Groups the teacher taught the student in this term. */
  groups: string[];
  state: RatingCardState;
  rating: OwnRating | null;
  /** From the server, never computed by the UI (§4.1). */
  opensAt: Date;
  editableUntil: Date;
};

export type RatingTermCards = {
  term: { id: string; name: string };
  cards: RatingCard[];
};

export type StudentRatings = {
  /** Terms whose rating window hasn't closed (newest first). */
  current: RatingTermCards[];
  /** Earlier terms with a rating of the student's, read-only. */
  earlier: RatingTermCards[];
  /** Teachers the student may rate and hasn't (badge, home card). */
  unrated: number;
};

type OwnRatingRow = OwnRating & { teacherId: string; termId: string };

async function ownRatings(
  db: Tx,
  studentId: string,
  where: { teacherId?: string; termId?: string } = {},
): Promise<OwnRatingRow[]> {
  return db.teacherRating.findMany({
    where: { studentId, ...where },
    select: {
      teacherId: true,
      termId: true,
      score: true,
      comment: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

type Facts = {
  student: StudentFacts;
  terms: TermRow[];
  attended: Map<string, Map<string, RatingLessonRow[]>>;
  ratings: OwnRatingRow[];
};

/** The term's first local day has begun. */
const hasStarted = (term: TermRow, now: Date, timeZone: string) =>
  zonedTimeToUtc(term.startDate, 0, timeZone) <= now;

async function loadFacts(
  db: Tx,
  userId: string,
  now: Date,
  timeZone: string,
  filter: { teacherId?: string; termId?: string } = {},
): Promise<Facts | null> {
  const student = await loadStudentFacts(db, userId);
  if (!student) return null;
  const terms = (await loadPublishedTerms(db)).filter(
    (t) =>
      (!filter.termId || t.id === filter.termId) &&
      hasStarted(t, now, timeZone),
  );
  const lessons = await loadEndedLessons(
    db,
    student,
    terms.map((t) => t.id),
    now,
  );
  return {
    student,
    terms,
    attended: attendedByTermAndTeacher(student, lessons, now),
    ratings: await ownRatings(db, student.studentId, filter),
  };
}

const toOwn = (row: OwnRatingRow): OwnRating => ({
  score: row.score,
  comment: row.comment,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

function cardsOf(
  facts: Facts,
  term: TermRow,
  teachers: Map<string, { name: string; active: boolean }>,
  now: Date,
  timeZone: string,
): RatingCard[] {
  const byTeacher = facts.attended.get(term.id) ?? new Map();
  const rated = new Map(
    facts.ratings
      .filter((r) => r.termId === term.id)
      .map((r) => [r.teacherId, r]),
  );
  const ids = new Set<string>([...byTeacher.keys(), ...rated.keys()]);
  const cards: RatingCard[] = [];
  for (const teacherId of ids) {
    const teacher = teachers.get(teacherId);
    if (!teacher) continue;
    const lessons: RatingLessonRow[] = byTeacher.get(teacherId) ?? [];
    const result = canRate({
      isStudent: true,
      teacherKnown: teacher.active,
      attended: lessons.length,
      term,
      timeZone,
      now,
    });
    const rating = rated.get(teacherId) ?? null;
    const state = ratingCardState(result, rating !== null);
    if (!state) continue;
    cards.push({
      teacherId,
      teacherName: teacher.name,
      substitute:
        lessons.length > 0 && lessons.every((l) => l.teacherId !== teacherId),
      groups: [...new Set(lessons.map((l) => l.groupName))].sort(),
      state,
      rating: rating && toOwn(rating),
      opensAt: result.opensAt,
      editableUntil: result.closesAt,
    });
  }
  return cards.sort(
    (a, b) =>
      a.teacherName.localeCompare(b.teacherName) ||
      a.teacherId.localeCompare(b.teacherId),
  );
}

async function teachersOf(db: Tx, facts: Facts) {
  const ids = new Set<string>(facts.ratings.map((r) => r.teacherId));
  for (const byTeacher of facts.attended.values()) {
    for (const id of byTeacher.keys()) ids.add(id);
  }
  return loadTeachers(db, [...ids]);
}

/** _Rate your teachers_ (design §6.3). */
export async function loadStudentRatings(
  db: SchoolDb,
  userId: string,
  now: Date,
  timeZone: string,
): Promise<StudentRatings> {
  const facts = await loadFacts(db, userId, now, timeZone);
  if (!facts) return { current: [], earlier: [], unrated: 0 };
  const teachers = await teachersOf(db, facts);
  const current: RatingTermCards[] = [];
  const earlier: RatingTermCards[] = [];
  for (const term of [...facts.terms].reverse()) {
    const cards = cardsOf(facts, term, teachers, now, timeZone);
    if (cards.length === 0) continue;
    const entry = { term: { id: term.id, name: term.name }, cards };
    const closed = ratingWindow(term, timeZone).closesAt <= now;
    (closed ? earlier : current).push(entry);
  }
  return {
    current,
    earlier,
    unrated: current.flatMap((t) => t.cards).filter((c) => c.state === "open")
      .length,
  };
}

/** The rating page for one teacher (design §6.4). */
export type RatingForm = {
  teacher: { id: string; name: string };
  term: { id: string; name: string };
  groups: string[];
  rating: OwnRating | null;
  /** False once the window closed: read-only. */
  editable: boolean;
  editableUntil: Date;
};

/**
 * The form for rating `teacherId`: in `termId`, or the newest term in which
 * the student can rate them or has rated them. Null (→ 404) when the
 * student can't rate the teacher and never did, or for malformed ids.
 */
export async function loadRatingForm(
  db: SchoolDb,
  userId: string,
  teacherId: string,
  termId: string | undefined,
  now: Date,
  timeZone: string,
): Promise<RatingForm | null> {
  if (!isUuid(teacherId) || (termId !== undefined && !isUuid(termId))) {
    return null;
  }
  const facts = await loadFacts(db, userId, now, timeZone, {
    teacherId,
    termId,
  });
  if (!facts) return null;
  const teachers = await loadTeachers(db, [teacherId]);
  const teacher = teachers.get(teacherId);
  if (!teacher) return null;
  for (const term of [...facts.terms].reverse()) {
    const card = cardsOf(facts, term, teachers, now, timeZone).find(
      (c) => c.teacherId === teacherId,
    );
    if (!card || card.state === "opensLater") continue;
    return {
      teacher: { id: teacherId, name: teacher.name },
      term: { id: term.id, name: term.name },
      groups: card.groups,
      rating: card.rating,
      editable: card.state === "open" || card.state === "rated",
      editableUntil: card.editableUntil,
    };
  }
  return null;
}

export type SaveRatingResult =
  { status: "saved"; created: boolean } | { status: "closed" };

const notFound = () => new AdminError(msg("common.error.notFound"));

/**
 * Creates or changes the student's rating (§4.2). Re-checks `canRate` at
 * write time; a teacher or term they can't rate is "not found", a closed
 * window is `closed`. Audited without the comment (§4.5).
 */
export async function saveRating(
  db: SchoolDb,
  userId: string,
  input: z.output<typeof saveRatingSchema>,
  now: Date,
  timeZone: string,
): Promise<SaveRatingResult> {
  return db.$transaction(async (tx) => {
    const facts = await loadFacts(tx, userId, now, timeZone, {
      teacherId: input.teacherId,
      termId: input.termId,
    });
    const term = facts?.terms.find((t) => t.id === input.termId);
    if (!facts || !term) throw notFound();
    const teacher = (await loadTeachers(tx, [input.teacherId])).get(
      input.teacherId,
    );
    if (!teacher) throw notFound();
    const existing = facts.ratings[0] ?? null;
    const result: CanRateResult = canRate({
      isStudent: true,
      teacherKnown: teacher.active,
      attended: facts.attended.get(term.id)?.get(input.teacherId)?.length ?? 0,
      term,
      timeZone,
      now,
    });
    if (!result.ok) {
      // Their own rating, read-only now; anything else isn't theirs to rate.
      if (existing) return { status: "closed" };
      throw notFound();
    }
    const schoolId = (
      await tx.school.findFirstOrThrow({ select: { id: true } })
    ).id;
    const rating = existing
      ? await tx.teacherRating.update({
          where: {
            schoolId_studentId_teacherId_termId: {
              schoolId,
              studentId: facts.student.studentId,
              teacherId: input.teacherId,
              termId: input.termId,
            },
          },
          data: { score: input.score, comment: input.comment, updatedAt: now },
          select: { id: true },
        })
      : await tx.teacherRating.create({
          data: {
            schoolId,
            studentId: facts.student.studentId,
            teacherId: input.teacherId,
            termId: input.termId,
            score: input.score,
            comment: input.comment,
            createdAt: now,
            updatedAt: now,
          },
          select: { id: true },
        });
    await tx.auditLog.create({
      data: {
        schoolId,
        actorId: userId,
        action: existing ? "rating.updated" : "rating.created",
        entityType: "TeacherRating",
        entityId: rating.id,
        data: {
          teacherId: input.teacherId,
          termId: input.termId,
          score: input.score,
          ...(existing && { previousScore: existing.score }),
        },
      },
    });
    return { status: "saved", created: !existing };
  });
}
