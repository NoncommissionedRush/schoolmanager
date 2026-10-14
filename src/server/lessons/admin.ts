// The admin's read-only lesson views (docs/design/lessons.md §7). Admins
// read every lesson of the school — the caller's `db` is already scoped to
// it — but write nothing (decision §12.1). Internal notes are loaded
// separately through src/server/notes.

import type { SchoolDb } from "@/server/timetable/service";

import type { LessonFilter } from "./rules";
import {
  type LessonList,
  type LessonPage,
  listLessons,
  loadLessonPage,
} from "./teacher";

/** Any lesson of the school, or null (→ 404, also for malformed ids). */
export async function loadAdminLesson(
  db: SchoolDb,
  lessonId: string,
  now: Date,
  timeZone: string,
): Promise<LessonPage | null> {
  const found = await loadLessonPage(db, {}, lessonId, now, timeZone);
  return found?.page ?? null;
}

/**
 * The school's lessons of one published term for a list filter; the default
 * "No log yet" shows which lessons are missing a log across the school.
 */
export async function listAdminLessons(
  db: SchoolDb,
  options: {
    filter: LessonFilter;
    termId?: string;
    groupId?: string;
    teacherId?: string;
  },
  now: Date,
  timeZone: string,
): Promise<LessonList> {
  return listLessons(db, {}, { ...options, withTeachers: true }, now, timeZone);
}
