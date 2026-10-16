import { beforeEach, describe, expect, it, vi } from "vitest";

// requireRole/getSchoolScopedDb with the framework and database mocked out.

const { auth, findUnique } = vi.hoisted(() => ({
  auth: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  cache: <T>(fn: T) => fn,
}));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/db", () => ({
  db: {
    membership: { findUnique },
    $extends: (extension: unknown) => ({ extension }),
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  forbidden: () => {
    throw new Error("forbidden");
  },
}));

const { requireRole, getSchoolScopedDb } = await import("./session");

const membership = (role: "ADMIN" | "TEACHER" | "STUDENT") => ({
  role,
  user: {
    id: "u1",
    name: "Alexandra Admin",
    email: "a@x.test",
    deletedAt: null,
    revokedSessions: [] as { id: string }[],
  },
  school: { id: "school-a", name: "Demo", timezone: "Europe/Bratislava" },
});

function signIn(role: "ADMIN" | "TEACHER" | "STUDENT", schoolId = "school-a") {
  auth.mockResolvedValue({
    identity: { userId: "u1", schoolId, role, sessionId: "sid-1" },
  });
}

beforeEach(() => {
  auth.mockReset();
  findUnique.mockReset();
});

describe("requireRole", () => {
  it("returns the viewer for an allowed role", async () => {
    signIn("ADMIN");
    findUnique.mockResolvedValue(membership("ADMIN"));
    await expect(requireRole("ADMIN")).resolves.toMatchObject({
      userId: "u1",
      role: "ADMIN",
      school: { id: "school-a" },
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { schoolId_userId: { schoolId: "school-a", userId: "u1" } },
      }),
    );
  });

  it("sends signed-out users to /login", async () => {
    auth.mockResolvedValue(null);
    await expect(requireRole("ADMIN")).rejects.toThrow("redirect:/login");
  });

  it("forbids a student on an admin page", async () => {
    signIn("STUDENT");
    findUnique.mockResolvedValue(membership("STUDENT"));
    await expect(requireRole("ADMIN")).rejects.toThrow("forbidden");
    await expect(requireRole("TEACHER")).rejects.toThrow("forbidden");
  });

  it("checks the role in the database, not the token", async () => {
    signIn("ADMIN"); // token still says admin…
    findUnique.mockResolvedValue(membership("TEACHER")); // …but was demoted
    await expect(requireRole("ADMIN")).rejects.toThrow("forbidden");
  });

  it("signs out a token whose session was revoked", async () => {
    signIn("TEACHER");
    const row = membership("TEACHER");
    findUnique.mockResolvedValue({
      ...row,
      user: { ...row.user, revokedSessions: [{ id: "sid-1" }] },
    });
    await expect(requireRole("TEACHER")).rejects.toThrow(
      "redirect:/logout?reason=expired",
    );
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          user: {
            select: expect.objectContaining({
              revokedSessions: {
                where: { id: "sid-1", schoolId: "school-a" },
                select: { id: true },
              },
            }),
          },
        }),
      }),
    );
  });

  it("signs out a token whose school membership is gone", async () => {
    signIn("ADMIN", "school-b");
    findUnique.mockResolvedValue(null);
    await expect(requireRole("ADMIN")).rejects.toThrow(
      "redirect:/logout?reason=expired",
    );
  });
});

describe("getSchoolScopedDb", () => {
  it("scopes the client to the viewer's school", async () => {
    signIn("TEACHER");
    findUnique.mockResolvedValue(membership("TEACHER"));
    const scoped = (await getSchoolScopedDb()) as unknown as {
      extension: { name: string };
    };
    expect(scoped.extension.name).toBe("school-scope");
  });

  it("requires a signed-in user", async () => {
    auth.mockResolvedValue(null);
    await expect(getSchoolScopedDb()).rejects.toThrow("redirect:/login");
  });
});
