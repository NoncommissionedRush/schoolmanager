import "server-only";

import { db } from "@/lib/db";
import type { Viewer } from "@/server/auth/access";
import { requireRole } from "@/server/auth/session";
import { scopeToSchool } from "@/server/db/school-scope";
import { GeneratorError } from "@/server/timetable/generator-service";
import { SchedulingError } from "@/server/timetable/service";

import { type ActionResult, AdminError, msg, toFailure } from "./result";
import type { Scope } from "./shared";

export type AdminContext = Scope & { viewer: Viewer };

/**
 * Every admin page and action starts here: the role is re-checked against
 * the database (403 otherwise) and all data access goes through the
 * school-scoped client.
 */
export async function adminContext(): Promise<AdminContext> {
  const viewer = await requireRole("ADMIN");
  return {
    viewer,
    db: scopeToSchool(db, viewer.school.id),
    schoolId: viewer.school.id,
    actor: { userId: viewer.userId },
  };
}

/**
 * Runs an admin server action: checks the role, then maps refusals from the
 * services (`AdminError`, `SchedulingError`, `GeneratorError`) to an
 * `ActionResult`. Anything else is a bug and propagates.
 */
export async function runAdminAction<T>(
  action: (context: AdminContext) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  const context = await adminContext();
  try {
    return await action(context);
  } catch (error) {
    if (error instanceof AdminError) return toFailure(error);
    if (error instanceof GeneratorError) {
      return {
        ok: false,
        formError: msg(`scheduling.generator.errors.${error.code}`),
      };
    }
    if (error instanceof SchedulingError) {
      return {
        ok: false,
        formError: msg(`scheduling.errors.${error.code}`),
      };
    }
    throw error;
  }
}
