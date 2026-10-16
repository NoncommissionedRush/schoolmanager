import { describe, expect, it } from "vitest";

import {
  feedPath,
  feedSecret,
  hashToken,
  MissingFeedSecretError,
  newSalt,
  parseFeedSegment,
  SALT_BYTES,
  TOKEN_PATTERN,
  tokenFor,
} from "./token";

const SECRET = "test-secret-0123456789abcdef0123456789";

describe("calendar link tokens", () => {
  it("are 256-bit base64url HMACs of the salt", () => {
    const salt = newSalt();
    expect(salt).toHaveLength(SALT_BYTES);
    const token = tokenFor(SECRET, salt);
    expect(token).toMatch(TOKEN_PATTERN);
    // The same salt gives the same token, so _Copy link_ shows it again.
    expect(tokenFor(SECRET, salt)).toBe(token);
  });

  it("differ per salt and per secret", () => {
    const salt = newSalt();
    expect(tokenFor(SECRET, newSalt())).not.toBe(tokenFor(SECRET, salt));
    expect(tokenFor(`${SECRET}x`, salt)).not.toBe(tokenFor(SECRET, salt));
  });

  it("are stored only as a sha256 hash", () => {
    const token = tokenFor(SECRET, newSalt());
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });
});

describe("feedSecret", () => {
  it("refuses a missing or short secret", () => {
    expect(() => feedSecret({})).toThrow(MissingFeedSecretError);
    expect(() => feedSecret({ ICAL_TOKEN_SECRET: "short" })).toThrow(
      MissingFeedSecretError,
    );
    expect(feedSecret({ ICAL_TOKEN_SECRET: SECRET })).toBe(SECRET);
  });
});

describe("feed URL", () => {
  const token = tokenFor(SECRET, newSalt());

  it("round-trips through the route segment", () => {
    const segment = feedPath(token).split("/").at(-1)!;
    expect(parseFeedSegment(segment)).toBe(token);
  });

  it.each([
    token,
    `${token}.ical`,
    `${token}x.ics`,
    "../etc/passwd.ics",
    ".ics",
    `${token.slice(0, -1)}+.ics`,
  ])("rejects %s", (segment) => {
    expect(parseFeedSegment(segment)).toBeNull();
  });
});
