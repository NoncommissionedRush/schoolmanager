import type { Role } from "@/server/auth/roles";
import type { SchoolDb } from "@/server/timetable/service";

// Teacher internal notes (TeacherNote) are for teachers and admins only —
// never students (project invariant). This module is the one place that
// reads them: every page, action or route handler that shows notes calls
// `findTeacherNotes`, which refuses students before any query runs.
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
  if (!canReadTeacherNotes(viewer.role)) {
    throw new TeacherNoteAccessError(viewer.role);
  }
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
