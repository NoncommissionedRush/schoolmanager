"use server";

import { auth, signOut } from "@/auth";
import { authConfig } from "@/auth.config";
import { db } from "@/lib/db";
import { LOGIN_PATH } from "@/server/auth/roles";
import { getViewer } from "@/server/auth/session";
import { revokeSession } from "@/server/auth/session-store";

// A token is re-issued (with a fresh expiry) on every proxied request, so keep
// the revocation a day longer than a token issued right now could live.
const REVOCATION_TTL_MS = (authConfig.session.maxAge + 24 * 60 * 60) * 1000;

export async function signOutAction() {
  // Only a session the server still accepts needs revoking; this also makes
  // sure the user and school rows exist.
  const [session, viewer] = await Promise.all([auth(), getViewer()]);
  if (session?.identity && viewer) {
    const now = new Date();
    await revokeSession(
      db,
      session.identity,
      new Date(now.getTime() + REVOCATION_TTL_MS),
      now,
    );
  }
  await signOut({ redirectTo: LOGIN_PATH });
}
