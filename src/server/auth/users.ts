import "server-only";

import { db } from "@/lib/db";

import type { CredentialUser } from "./credentials";

/** Loads what a password sign-in needs; memberships oldest first. */
export function findCredentialUser(
  email: string,
): Promise<CredentialUser | null> {
  return db.user.findUnique({
    where: { email },
    select: {
      id: true,
      passwordHash: true,
      deletedAt: true,
      memberships: {
        select: { schoolId: true, role: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
}
