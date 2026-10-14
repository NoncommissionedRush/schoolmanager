import { describe, expect, it, vi } from "vitest";

import {
  normalizeEmail,
  verifyCredentials,
  type CredentialUser,
} from "./credentials";

const user: CredentialUser = {
  id: "user-1",
  passwordHash: "hash:secret",
  deletedAt: null,
  memberships: [
    { schoolId: "school-a", role: "TEACHER" },
    { schoolId: "school-b", role: "ADMIN" },
  ],
};

function deps(found: CredentialUser | null) {
  return {
    findUserByEmail: vi.fn(async () => found),
    verifyPassword: vi.fn(
      async (password: string, hash: string) => hash === `hash:${password}`,
    ),
  };
}

describe("verifyCredentials", () => {
  it("signs in with the oldest membership", async () => {
    const d = deps(user);
    await expect(
      verifyCredentials({ email: " Jana@School.TEST ", password: "secret" }, d),
    ).resolves.toEqual({
      ok: true,
      identity: { userId: "user-1", schoolId: "school-a", role: "TEACHER" },
    });
    expect(d.findUserByEmail).toHaveBeenCalledWith("jana@school.test");
  });

  it("rejects a wrong password", async () => {
    await expect(
      verifyCredentials({ email: "a@b.test", password: "nope" }, deps(user)),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects an unknown email the same way, still checking a hash", async () => {
    const d = deps(null);
    await expect(
      verifyCredentials({ email: "x@b.test", password: "secret" }, d),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(d.verifyPassword).toHaveBeenCalledOnce();
  });

  it("rejects users without a password", async () => {
    await expect(
      verifyCredentials(
        { email: "a@b.test", password: "secret" },
        deps({ ...user, passwordHash: null }),
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("reports deleted users as disabled once the password matched", async () => {
    await expect(
      verifyCredentials(
        { email: "a@b.test", password: "secret" },
        deps({ ...user, deletedAt: new Date() }),
      ),
    ).resolves.toEqual({ ok: false, reason: "disabled" });
  });

  it("reports users without any membership as disabled", async () => {
    await expect(
      verifyCredentials(
        { email: "a@b.test", password: "secret" },
        deps({ ...user, memberships: [] }),
      ),
    ).resolves.toEqual({ ok: false, reason: "disabled" });
  });

  it("does not reveal 'disabled' for a wrong password", async () => {
    await expect(
      verifyCredentials(
        { email: "a@b.test", password: "nope" },
        deps({ ...user, deletedAt: new Date() }),
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });
});

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeEmail("  Admin@Demo-School.TEST ")).toBe(
      "admin@demo-school.test",
    );
  });
});
