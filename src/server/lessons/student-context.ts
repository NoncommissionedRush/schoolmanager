import "server-only";

import { db } from "@/lib/db";
import type { Viewer } from "@/server/auth/access";
import { requireRole } from "@/server/auth/session";
import { scopeToSchool } from "@/server/db/school-scope";
import type { SchoolDb } from "@/server/timetable/service";

import { loadStudentScope, type StudentScope } from "./student";

export type StudentContext = {
  viewer: Viewer;
  db: SchoolDb;
  scope: StudentScope;
};

/**
 * Every student lesson page starts here: the role is re-checked against the
 * database (403 otherwise) and all data access goes through the
 * school-scoped client. Kept apart from `context.ts`, which knows about
 * internal notes.
 */
export async function studentContext(): Promise<StudentContext> {
  const viewer = await requireRole("STUDENT");
  const scoped = scopeToSchool(db, viewer.school.id);
  return {
    viewer,
    db: scoped,
    scope: await loadStudentScope(scoped, viewer.userId),
  };
}
