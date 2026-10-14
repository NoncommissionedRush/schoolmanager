import type { SessionIdentity } from "./credentials";
import type { Role } from "./roles";

/** The signed-in user as every page and server action sees them. */
export type Viewer = {
  userId: string;
  name: string;
  email: string;
  role: Role;
  school: { id: string; name: string; timezone: string };
};

/** A membership row joined with its user and school. */
export type MembershipRecord = {
  role: Role;
  user: { id: string; name: string; email: string; deletedAt: Date | null };
  school: { id: string; name: string; timezone: string };
};

export type FindMembership = (
  schoolId: string,
  userId: string,
) => Promise<MembershipRecord | null>;

/**
 * Resolves the session token to a viewer from the database. The role comes
 * from the current `Membership` row, not from the token, so a role change or
 * removal takes effect on the next request; deleted users get no viewer.
 */
export async function loadViewer(
  identity: SessionIdentity | null,
  findMembership: FindMembership,
): Promise<Viewer | null> {
  if (!identity) return null;
  const membership = await findMembership(identity.schoolId, identity.userId);
  if (!membership || membership.user.deletedAt) return null;
  return {
    userId: membership.user.id,
    name: membership.user.name,
    email: membership.user.email,
    role: membership.role,
    school: membership.school,
  };
}

export type AccessResult = "ok" | "unauthenticated" | "forbidden";

export function checkAccess(
  viewer: Viewer | null,
  allowedRoles: readonly Role[],
): AccessResult {
  if (!viewer) return "unauthenticated";
  return allowedRoles.includes(viewer.role) ? "ok" : "forbidden";
}
