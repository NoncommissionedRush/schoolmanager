import type { Role } from "./roles";

/** What a successful sign-in puts into the session. */
export type SessionIdentity = { userId: string; schoolId: string; role: Role };

export type SignInFailure = "invalid" | "disabled";

export type SignInResult =
  | { ok: true; identity: SessionIdentity }
  | { ok: false; reason: SignInFailure };

/** The subset of a user row needed to check a password sign-in. */
export type CredentialUser = {
  id: string;
  passwordHash: string | null;
  deletedAt: Date | null;
  /** The user's membership; at most one (unique `Membership.userId`). */
  memberships: { schoolId: string; role: Role }[];
};

export type CredentialDeps = {
  findUserByEmail(email: string): Promise<CredentialUser | null>;
  verifyPassword(password: string, hash: string): Promise<boolean>;
};

// Compared against when the email is unknown so the response time does not
// reveal whether an account exists. bcrypt hash of a random string.
const DUMMY_HASH =
  "$2b$12$qXPvjAkljMaWJQK1LRWnpe5m9w2u7pBKA2nw0ThriYqblF6ApVu5e";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Email + password sign-in. Never reveals whether the email exists: unknown
 * email, missing password and wrong password all fail as "invalid". A user
 * is "disabled" when soft-deleted or no longer a member of any school (only
 * reported after the password matched).
 *
 * Every user belongs to exactly one school, so the session school is the
 * school of their only membership.
 */
export async function verifyCredentials(
  input: { email: string; password: string },
  deps: CredentialDeps,
): Promise<SignInResult> {
  const user = await deps.findUserByEmail(normalizeEmail(input.email));
  const passwordOk = await deps.verifyPassword(
    input.password,
    user?.passwordHash ?? DUMMY_HASH,
  );
  if (!user || !user.passwordHash || !passwordOk) {
    return { ok: false, reason: "invalid" };
  }
  const membership = user.memberships[0];
  if (user.deletedAt || !membership) return { ok: false, reason: "disabled" };
  return {
    ok: true,
    identity: {
      userId: user.id,
      schoolId: membership.schoolId,
      role: membership.role,
    },
  };
}
