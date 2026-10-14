import "server-only";

import { db } from "@/lib/db";

import type { CredentialUser } from "./credentials";

/** Loads what a password sign-in needs, including the user's membership. */
export function findCredentialUser(
  email: string,
): Promise<CredentialUser | null> {
  return db.user.findUnique({
    where: { email },
    select: {
      id: true,
      passwordHash: true,
      deletedAt: true,
      memberships: { select: { schoolId: true, role: true } },
    },
  });
}
