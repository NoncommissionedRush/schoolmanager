import type { PrismaClient } from "@/generated/prisma/client";

import type { MembershipRecord } from "./access";
import type { TokenIdentity } from "./credentials";

/**
 * The membership behind a session token, joined with its user and school,
 * and whether this session was signed out. Unscoped: it runs before the
 * school is known to be the viewer's.
 */
export async function findSessionMembership(
  db: Pick<PrismaClient, "membership">,
  { schoolId, userId, sessionId }: TokenIdentity,
): Promise<MembershipRecord | null> {
  const membership = await db.membership.findUnique({
    where: { schoolId_userId: { schoolId, userId } },
    select: {
      role: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          deletedAt: true,
          revokedSessions: {
            where: { id: sessionId, schoolId },
            select: { id: true },
          },
        },
      },
      school: { select: { id: true, name: true, timezone: true } },
    },
  });
  if (!membership) return null;
  const { revokedSessions, ...user } = membership.user;
  return { ...membership, user, sessionRevoked: revokedSessions.length > 0 };
}

/**
 * Records a sign-out so the server refuses this session's token from now on.
 * Deleting the cookie alone is not enough: a response that was already in
 * flight (e.g. a link prefetch) can arrive afterwards and set it again.
 *
 * The row is kept until `expiresAt` — set it past the token's own expiry —
 * and expired rows are pruned on the way.
 */
export async function revokeSession(
  db: Pick<PrismaClient, "revokedSession">,
  identity: TokenIdentity,
  expiresAt: Date,
  now: Date = new Date(),
): Promise<void> {
  // Deliberately not scoped to `identity.schoolId`: an expired row refuses
  // nothing (its token has expired too) and holds no school data beyond the
  // ids, so any sign-out may clean up every school's. Scoping it would leave
  // the rows of a school nobody signs out of growing forever.
  await db.revokedSession.deleteMany({ where: { expiresAt: { lt: now } } });
  await db.revokedSession.createMany({
    data: [
      {
        id: identity.sessionId,
        schoolId: identity.schoolId,
        userId: identity.userId,
        revokedAt: now,
        expiresAt,
      },
    ],
    skipDuplicates: true,
  });
}
