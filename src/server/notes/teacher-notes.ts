import type { Prisma } from "@/generated/prisma/client";
import { AdminError, msg } from "@/server/admin/result";
import type { Role } from "@/server/auth/roles";
import {
  findTeacherLessonGroup,
  isUuid,
  teacherLessonWhere,
} from "@/server/lessons/access";
import { EARLIER_NOTES_PAGE } from "@/server/lessons/rules";
import {
  type CreateNoteInput,
  parseAbout,
  type UpdateNoteInput,
} from "@/server/lessons/schema";
import type { SchoolDb } from "@/server/timetable/service";

// Teacher internal notes (TeacherNote) are for teachers and admins only —
// never students (project invariant, lessons.md §2 and §11). This module is
// the one place that reads them: every page, action or route handler that
// shows notes calls a function here, and each of them refuses students
// before any query runs. Teachers only get notes of lessons they teach or
// substitute. Student loaders must never import this module.
// teacher-notes.test.ts fails the build if code elsewhere in src/ reads the
// TeacherNote table directly.

export const TEACHER_NOTE_READERS: readonly Role[] = ["ADMIN", "TEACHER"];

export function canReadTeacherNotes(role: Role): boolean {
  return TEACHER_NOTE_READERS.includes(role);
}

export class TeacherNoteAccessError extends Error {
  constructor(role: Role) {
    super(`Teacher notes are not readable by the ${role} role`);
    this.name = "TeacherNoteAccessError";
  }
}

/** Who is asking: their role and, for teachers, their TeacherProfile id. */
export type NoteViewer = { role: Role; teacherId?: string | null };

function assertNoteReader(viewer: { role: Role }) {
  if (!canReadTeacherNotes(viewer.role)) {
    throw new TeacherNoteAccessError(viewer.role);
  }
}

/** What the notes are about; at least one is required. */
export type TeacherNoteFilter = {
  studentId?: string;
  groupId?: string;
  lessonId?: string;
};

const noteSelect = {
  id: true,
  body: true,
  studentId: true,
  groupId: true,
  lessonId: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, user: { select: { name: true } } } },
} as const;

/**
 * Notes about a student, group or lesson, newest first, for a teacher or an
 * admin of the school `db` is scoped to. Throws `TeacherNoteAccessError`
 * for any other role — callers should already have checked the role with
 * `requireRole("ADMIN", "TEACHER")`; this is the backstop.
 */
export async function findTeacherNotes(
  db: SchoolDb,
  viewer: { role: Role },
  filter: TeacherNoteFilter,
) {
  assertNoteReader(viewer);
  const where = Object.fromEntries(
    Object.entries(filter).filter(([, id]) => id !== undefined),
  );
  if (Object.keys(where).length === 0) {
    throw new Error("findTeacherNotes needs a student, group or lesson");
  }
  return db.teacherNote.findMany({
    where,
    select: noteSelect,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
}

// ---------------------------------------------------------------------------
// Lesson page (lessons.md §5.3)
// ---------------------------------------------------------------------------

export type NoteAbout =
  | { kind: "lesson" }
  | { kind: "group"; name: string }
  | { kind: "student"; name: string };

/** A note as the lesson page shows it. Only ever sent to teachers and admins. */
export type NoteView = {
  id: string;
  body: string;
  author: { id: string; name: string };
  about: NoteAbout;
  createdAt: string;
  edited: boolean;
  /** The viewer wrote it, so they may edit and delete it. */
  own: boolean;
  /** Start of the lesson the note was written on, if any. */
  lessonStartsAt: string | null;
};

const noteViewSelect = {
  id: true,
  body: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, user: { select: { name: true } } } },
  group: { select: { name: true } },
  student: { select: { user: { select: { name: true } } } },
  lesson: { select: { startsAt: true } },
} satisfies Prisma.TeacherNoteSelect;

type NoteRow = Prisma.TeacherNoteGetPayload<{ select: typeof noteViewSelect }>;

function toNoteView(row: NoteRow, viewer: NoteViewer): NoteView {
  const about: NoteAbout = row.student
    ? { kind: "student", name: row.student.user.name }
    : row.group
      ? { kind: "group", name: row.group.name }
      : { kind: "lesson" };
  return {
    id: row.id,
    body: row.body,
    author: { id: row.author.id, name: row.author.user.name },
    about,
    createdAt: row.createdAt.toISOString(),
    // Prisma sets both timestamps on create; an edit moves `updatedAt`.
    edited: row.updatedAt.getTime() - row.createdAt.getTime() > 1000,
    own: viewer.teacherId != null && row.author.id === viewer.teacherId,
    lessonStartsAt: row.lesson?.startsAt.toISOString() ?? null,
  };
}

const notFound = () => new AdminError(msg("common.error.notFound"));

/**
 * The lesson the viewer may see notes of: any lesson of the school for an
 * admin, only lessons they teach or substitute for a teacher.
 */
async function readableLesson(
  db: SchoolDb,
  viewer: NoteViewer,
  lessonId: string,
): Promise<{ id: string; groupId: string }> {
  assertNoteReader(viewer);
  const lesson =
    viewer.role === "ADMIN"
      ? isUuid(lessonId)
        ? await db.lesson.findFirst({
            where: { id: lessonId },
            select: { id: true, groupId: true },
          })
        : null
      : await findTeacherLessonGroup(db, viewer.teacherId ?? null, lessonId);
  if (!lesson) throw notFound();
  return lesson;
}

/** Students in the group now or later (not those who have left). */
async function currentMemberIds(db: SchoolDb, groupId: string, now: Date) {
  const rows = await db.groupMembership.findMany({
    where: { groupId, OR: [{ leftAt: null }, { leftAt: { gt: now } }] },
    select: { studentId: true },
  });
  return rows.map((r) => r.studentId);
}

/**
 * Notes from other lessons about this group, its lessons or one of its
 * current members (§5.3 "Earlier notes").
 */
function earlierWhere(
  lesson: { id: string; groupId: string },
  memberIds: string[],
): Prisma.TeacherNoteWhereInput {
  return {
    AND: [
      { OR: [{ lessonId: null }, { lessonId: { not: lesson.id } }] },
      {
        OR: [
          { groupId: lesson.groupId },
          { studentId: { in: memberIds } },
          { lesson: { groupId: lesson.groupId } },
        ],
      },
    ],
  };
}

const newestFirst = [
  { createdAt: "desc" },
  { id: "asc" },
] satisfies Prisma.TeacherNoteOrderByWithRelationInput[];

export type LessonNotes = {
  onLesson: NoteView[];
  earlier: NoteView[];
  earlierCount: number;
};

/** Notes on a lesson plus the first page of earlier notes (§5.3). */
export async function loadLessonNotes(
  db: SchoolDb,
  viewer: NoteViewer,
  lessonId: string,
  now: Date,
): Promise<LessonNotes> {
  const lesson = await readableLesson(db, viewer, lessonId);
  const memberIds = await currentMemberIds(db, lesson.groupId, now);
  const earlier = earlierWhere(lesson, memberIds);
  const [onLesson, earlierRows, earlierCount] = await Promise.all([
    db.teacherNote.findMany({
      where: { lessonId: lesson.id },
      select: noteViewSelect,
      orderBy: newestFirst,
    }),
    db.teacherNote.findMany({
      where: earlier,
      select: noteViewSelect,
      orderBy: newestFirst,
      take: EARLIER_NOTES_PAGE,
    }),
    db.teacherNote.count({ where: earlier }),
  ]);
  return {
    onLesson: onLesson.map((row) => toNoteView(row, viewer)),
    earlier: earlierRows.map((row) => toNoteView(row, viewer)),
    earlierCount,
  };
}

/** The next page of earlier notes ("Show more"). */
export async function loadEarlierNotes(
  db: SchoolDb,
  viewer: NoteViewer,
  lessonId: string,
  offset: number,
  now: Date,
): Promise<NoteView[]> {
  const lesson = await readableLesson(db, viewer, lessonId);
  const memberIds = await currentMemberIds(db, lesson.groupId, now);
  const rows = await db.teacherNote.findMany({
    where: earlierWhere(lesson, memberIds),
    select: noteViewSelect,
    orderBy: newestFirst,
    skip: Math.max(0, Math.floor(offset)),
    take: EARLIER_NOTES_PAGE,
  });
  return rows.map((row) => toNoteView(row, viewer));
}

// ---------------------------------------------------------------------------
// Student detail › Internal notes (lessons.md §7): admins only
// ---------------------------------------------------------------------------

/**
 * Every note about one student, newest first, read-only. Admins only: a
 * teacher reads notes through the lessons they teach (`loadLessonNotes`).
 */
export async function loadStudentNotes(
  db: SchoolDb,
  viewer: NoteViewer,
  studentId: string,
): Promise<NoteView[]> {
  assertNoteReader(viewer);
  if (viewer.role !== "ADMIN" || !isUuid(studentId)) throw notFound();
  const rows = await db.teacherNote.findMany({
    where: { studentId },
    select: noteViewSelect,
    orderBy: newestFirst,
  });
  // Admins never own notes, so nothing is editable here.
  return rows.map((row) => toNoteView(row, { role: viewer.role }));
}

// ---------------------------------------------------------------------------
// Writes: teachers only, on lessons they teach or substitute; a note can be
// changed or deleted only by its author. Admins read notes but don't write
// them (lessons.md §7).
// ---------------------------------------------------------------------------

function writer(viewer: NoteViewer): string {
  assertNoteReader(viewer);
  if (viewer.role !== "TEACHER" || !viewer.teacherId) throw notFound();
  return viewer.teacherId;
}

/** Adds a note on a lesson about the lesson, its group or one student. */
export async function createLessonNote(
  db: SchoolDb,
  schoolId: string,
  viewer: NoteViewer,
  input: CreateNoteInput,
  now: Date,
): Promise<NoteView> {
  const teacherId = writer(viewer);
  const lesson = await findTeacherLessonGroup(db, teacherId, input.lessonId);
  if (!lesson) throw notFound();
  const about = parseAbout(input.about);
  if (about.kind === "student") {
    const members = await currentMemberIds(db, lesson.groupId, now);
    if (!members.includes(about.id)) {
      throw new AdminError(
        msg("validation.select", {
          field: msg("teacherNotes.about.label"),
        }),
        "about",
      );
    }
  }
  const row = await db.teacherNote.create({
    data: {
      schoolId,
      authorId: teacherId,
      lessonId: lesson.id,
      groupId: about.kind === "group" ? lesson.groupId : null,
      studentId: about.kind === "student" ? about.id : null,
      body: input.body,
    },
    select: noteViewSelect,
  });
  return toNoteView(row, viewer);
}

/** The viewer's own note, on a lesson they can still open (or on none). */
async function ownNote(db: SchoolDb, teacherId: string, noteId: string) {
  if (!isUuid(noteId)) throw notFound();
  const note = await db.teacherNote.findFirst({
    where: {
      id: noteId,
      authorId: teacherId,
      OR: [{ lessonId: null }, { lesson: teacherLessonWhere(teacherId) }],
    },
    select: { id: true },
  });
  if (!note) throw notFound();
  return note;
}

export async function updateLessonNote(
  db: SchoolDb,
  viewer: NoteViewer,
  input: UpdateNoteInput,
): Promise<NoteView> {
  const teacherId = writer(viewer);
  const note = await ownNote(db, teacherId, input.noteId);
  const row = await db.teacherNote.update({
    where: { id: note.id },
    data: { body: input.body },
    select: noteViewSelect,
  });
  return toNoteView(row, viewer);
}

export async function deleteLessonNote(
  db: SchoolDb,
  viewer: NoteViewer,
  noteId: string,
): Promise<void> {
  const teacherId = writer(viewer);
  const note = await ownNote(db, teacherId, noteId);
  await db.teacherNote.delete({ where: { id: note.id } });
}
