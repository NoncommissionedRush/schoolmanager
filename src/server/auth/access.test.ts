import { describe, expect, it, vi } from "vitest";

import { checkAccess, loadViewer, type MembershipRecord } from "./access";

const record: MembershipRecord = {
  role: "TEACHER",
  user: {
    id: "u1",
    name: "Jana Nováková",
    email: "jana@x.test",
    deletedAt: null,
  },
  sessionRevoked: false,
  school: { id: "s1", name: "Demo", timezone: "Europe/Bratislava" },
};

describe("loadViewer", () => {
  it("returns null without a session", async () => {
    const find = vi.fn();
    await expect(loadViewer(null, find)).resolves.toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  it("looks the membership up by the session's school and user", async () => {
    const find = vi.fn(async () => record);
    const viewer = await loadViewer(
      { userId: "u1", schoolId: "s1", role: "TEACHER", sessionId: "sid" },
      find,
    );
    expect(find).toHaveBeenCalledWith({
      userId: "u1",
      schoolId: "s1",
      role: "TEACHER",
      sessionId: "sid",
    });
    expect(viewer).toEqual({
      userId: "u1",
      name: "Jana Nováková",
      email: "jana@x.test",
      role: "TEACHER",
      school: record.school,
    });
  });

  it("uses the role from the database, not the token", async () => {
    const viewer = await loadViewer(
      { userId: "u1", schoolId: "s1", role: "ADMIN", sessionId: "sid" },
      async () => record,
    );
    expect(viewer?.role).toBe("TEACHER");
  });

  it("denies a session whose membership no longer exists (e.g. other school)", async () => {
    await expect(
      loadViewer(
        { userId: "u1", schoolId: "s2", role: "ADMIN", sessionId: "sid" },
        async () => null,
      ),
    ).resolves.toBeNull();
  });

  it("denies deleted users", async () => {
    await expect(
      loadViewer(
        { userId: "u1", schoolId: "s1", role: "TEACHER", sessionId: "sid" },
        async () => ({
          ...record,
          user: { ...record.user, deletedAt: new Date() },
        }),
      ),
    ).resolves.toBeNull();
  });

  it("denies a signed-out session even if its cookie came back", async () => {
    await expect(
      loadViewer(
        { userId: "u1", schoolId: "s1", role: "TEACHER", sessionId: "sid" },
        async () => ({ ...record, sessionRevoked: true }),
      ),
    ).resolves.toBeNull();
  });
});

describe("checkAccess", () => {
  const viewer = {
    userId: "u1",
    name: "A",
    email: "a@x.test",
    role: "STUDENT" as const,
    school: record.school,
  };

  it("requires a viewer", () => {
    expect(checkAccess(null, ["ADMIN"])).toBe("unauthenticated");
  });

  it("allows listed roles", () => {
    expect(checkAccess(viewer, ["TEACHER", "STUDENT"])).toBe("ok");
  });

  it("forbids other roles", () => {
    expect(checkAccess(viewer, ["ADMIN", "TEACHER"])).toBe("forbidden");
  });
});
