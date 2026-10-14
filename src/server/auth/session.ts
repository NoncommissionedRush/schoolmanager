import "server-only";

import { forbidden, redirect } from "next/navigation";
import { cache } from "react";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { scopeToSchool } from "@/server/db/school-scope";

import { checkAccess, loadViewer, type Viewer } from "./access";
import { LOGIN_PATH, type Role } from "./roles";

/**
 * Data access layer for the signed-in user. Every page, layout, route
 * handler and server action that touches school data goes through
 * `requireRole` / `getSchoolScopedDb` — never trust the proxy or the UI alone.
 */

/** The signed-in viewer (membership re-checked in the DB), or null. Per request. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const session = await auth();
  return loadViewer(session?.identity ?? null, (schoolId, userId) =>
    db.membership.findUnique({
      where: { schoolId_userId: { schoolId, userId } },
      select: {
        role: true,
        user: {
          select: { id: true, name: true, email: true, deletedAt: true },
        },
        school: { select: { id: true, name: true, timezone: true } },
      },
    }),
  );
});

/**
 * Returns the viewer if their role is allowed. Signed out → login; a session
 * whose membership was removed → signed out; wrong role → 403.
 */
export async function requireRole(...allowedRoles: Role[]): Promise<Viewer> {
  const viewer = await getViewer();
  switch (checkAccess(viewer, allowedRoles)) {
    case "ok":
      return viewer!;
    case "forbidden":
      forbidden();
    case "unauthenticated": {
      // A still-valid token without a membership (user removed or deleted)
      // must be cleared first, otherwise the proxy bounces /login back here.
      const session = await auth();
      redirect(session ? "/logout?reason=expired" : LOGIN_PATH);
    }
  }
}

/** Any signed-in user, whatever their role. */
export function requireViewer(): Promise<Viewer> {
  return requireRole("ADMIN", "TEACHER", "STUDENT");
}

/** A Prisma client whose every query is scoped to the viewer's school. */
export async function getSchoolScopedDb() {
  const viewer = await requireViewer();
  return scopeToSchool(db, viewer.school.id);
}
