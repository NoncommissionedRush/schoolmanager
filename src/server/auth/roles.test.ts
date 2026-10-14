import { describe, expect, it } from "vitest";

import {
  areaRole,
  postLoginPath,
  routeDecision,
  safeCallbackPath,
} from "./roles";

describe("areaRole", () => {
  it.each([
    ["/admin", "ADMIN"],
    ["/admin/students", "ADMIN"],
    ["/teacher", "TEACHER"],
    ["/student/timetable", "STUDENT"],
    ["/administrator", null],
    ["/", null],
    ["/login", null],
  ])("%s → %s", (path, role) => {
    expect(areaRole(path)).toBe(role);
  });
});

describe("safeCallbackPath", () => {
  it.each([
    ["/admin/students?page=2", "/admin/students?page=2"],
    ["//evil.test/admin", null],
    ["/\\evil.test", null],
    ["https://evil.test", null],
    ["/login", null],
    ["/login?callbackUrl=/admin", null],
    ["", null],
    [undefined, null],
  ])("%s → %s", (value, expected) => {
    expect(safeCallbackPath(value)).toBe(expected);
  });
});

describe("postLoginPath", () => {
  it("defaults to the role's dashboard", () => {
    expect(postLoginPath("TEACHER", null)).toBe("/teacher");
  });

  it("returns to a callback inside the role's area", () => {
    expect(postLoginPath("ADMIN", "/admin/students")).toBe("/admin/students");
  });

  it("ignores a callback into another role's area", () => {
    expect(postLoginPath("STUDENT", "/admin")).toBe("/student");
  });

  it("ignores unsafe callbacks", () => {
    expect(postLoginPath("ADMIN", "//evil.test")).toBe("/admin");
  });
});

describe("routeDecision", () => {
  const signedOut = { role: null, sessionExpired: false, search: "" };

  it("lets signed-out users open /login", () => {
    expect(routeDecision({ ...signedOut, pathname: "/login" })).toEqual({
      kind: "next",
    });
  });

  it("sends signed-out users to /login with a callback", () => {
    expect(
      routeDecision({
        ...signedOut,
        pathname: "/admin/students",
        search: "?q=a",
      }),
    ).toEqual({
      kind: "redirect",
      to: "/login?callbackUrl=%2Fadmin%2Fstudents%3Fq%3Da",
    });
  });

  it("flags an expired session on the way to /login", () => {
    expect(
      routeDecision({
        ...signedOut,
        sessionExpired: true,
        pathname: "/teacher",
      }),
    ).toEqual({
      kind: "redirect",
      to: "/login?callbackUrl=%2Fteacher&reason=expired",
    });
  });

  it("sends signed-out users from / to /login without a callback", () => {
    expect(routeDecision({ ...signedOut, pathname: "/" })).toEqual({
      kind: "redirect",
      to: "/login",
    });
  });

  it("protects shared pages too", () => {
    expect(routeDecision({ ...signedOut, pathname: "/forbidden" }).kind).toBe(
      "redirect",
    );
  });

  it("redirects / to the role's dashboard", () => {
    expect(
      routeDecision({ ...signedOut, role: "TEACHER", pathname: "/" }),
    ).toEqual({ kind: "redirect", to: "/teacher" });
  });

  it("redirects / to an allowed callback after sign-in", () => {
    expect(
      routeDecision({
        ...signedOut,
        role: "ADMIN",
        pathname: "/",
        search: "?callbackUrl=%2Fadmin%2Fteachers",
      }),
    ).toEqual({ kind: "redirect", to: "/admin/teachers" });
  });

  it("redirects signed-in users away from /login", () => {
    expect(
      routeDecision({ ...signedOut, role: "STUDENT", pathname: "/login" }),
    ).toEqual({ kind: "redirect", to: "/student" });
  });

  it.each([
    ["STUDENT", "/admin"],
    ["STUDENT", "/teacher/timetable"],
    ["TEACHER", "/admin/settings"],
    ["ADMIN", "/student"],
  ] as const)("forbids %s on %s", (role, pathname) => {
    expect(routeDecision({ ...signedOut, role, pathname })).toEqual({
      kind: "forbidden",
    });
  });

  it.each([
    ["ADMIN", "/admin/students"],
    ["TEACHER", "/teacher"],
    ["STUDENT", "/student"],
    ["STUDENT", "/forbidden"],
  ] as const)("allows %s on %s", (role, pathname) => {
    expect(routeDecision({ ...signedOut, role, pathname })).toEqual({
      kind: "next",
    });
  });
});
