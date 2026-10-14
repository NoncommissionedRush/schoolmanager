import "server-only";

import { db } from "@/lib/db";
import {
  type ActionResult,
  AdminError,
  toFailure,
} from "@/server/admin/result";
import type { Viewer } from "@/server/auth/access";
import { requireRole } from "@/server/auth/session";
import { scopeToSchool } from "@/server/db/school-scope";
import type { NoteViewer } from "@/server/notes/teacher-notes";
import type { SchoolDb } from "@/server/timetable/service";

import { teacherProfileId } from "./access";

export type TeacherContext = {
  viewer: Viewer;
  db: SchoolDb;
  schoolId: string;
  /** The teacher's profile in this school; null means no lesson is theirs. */
  teacherId: string | null;
  /** What the internal-notes module needs to know about the viewer. */
  noteViewer: NoteViewer;
};

/**
 * Every teacher lesson page and action starts here: the role is re-checked
 * against the database (403 otherwise) and all data access goes through the
 * school-scoped client.
 */
export async function teacherContext(): Promise<TeacherContext> {
  const viewer = await requireRole("TEACHER");
  const scoped = scopeToSchool(db, viewer.school.id);
  const teacherId = await teacherProfileId(scoped, viewer.userId);
  return {
    viewer,
    db: scoped,
    schoolId: viewer.school.id,
    teacherId,
    noteViewer: { role: viewer.role, teacherId },
  };
}

/** Runs a teacher server action; service refusals become an `ActionResult`. */
export async function runTeacherAction<T>(
  action: (context: TeacherContext) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  const context = await teacherContext();
  try {
    return await action(context);
  } catch (error) {
    if (error instanceof AdminError) return toFailure(error);
    throw error;
  }
}
