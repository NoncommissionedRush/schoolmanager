// Calendar link tokens (docs/architecture/phase5-rules.md §5.1):
// `token = base64url(HMAC-SHA256(ICAL_TOKEN_SECRET, salt))`, and only
// `sha256(token)` is stored. The server can show the same link again from
// the salt, a database dump alone can't produce working links, and changing
// the secret turns every link off.

import { createHash, createHmac, randomBytes } from "node:crypto";

export const SALT_BYTES = 32;
const MIN_SECRET_LENGTH = 32;

export class MissingFeedSecretError extends Error {
  constructor() {
    super(
      `ICAL_TOKEN_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters`,
    );
    this.name = "MissingFeedSecretError";
  }
}

/** The signing secret; calendar links don't work without it. */
export function feedSecret(
  env: Record<string, string | undefined> = process.env,
): string {
  const secret = env.ICAL_TOKEN_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new MissingFeedSecretError();
  }
  return secret;
}

export const newSalt = (): Uint8Array<ArrayBuffer> =>
  new Uint8Array(randomBytes(SALT_BYTES));

export function tokenFor(secret: string, salt: Uint8Array): string {
  return createHmac("sha256", secret).update(salt).digest("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A 256-bit base64url token: 43 characters of `[A-Za-z0-9_-]`. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The feed URL path of a token. */
export const feedPath = (token: string) => `/api/calendar/${token}.ics`;

/** `<token>.ics` from the route segment → the token, or null. */
export function parseFeedSegment(segment: string): string | null {
  if (!segment.endsWith(".ics")) return null;
  const token = segment.slice(0, -".ics".length);
  return TOKEN_PATTERN.test(token) ? token : null;
}
