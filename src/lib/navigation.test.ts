import { describe, expect, it } from "vitest";

import {
  groupNavigation,
  isActiveHref,
  navigationFor,
  studentTabs,
} from "./navigation";

describe("navigationFor", () => {
  it("shows only shipped items (P0: the dashboards)", () => {
    // The admin data screens (CARM-24) and the timetables (CARM-25) ship
    // ahead of the rest of P1; the admin lesson list (CARM-36) ahead of P2.
    expect(navigationFor("ADMIN", 0).map((i) => i.href)).toEqual([
      "/admin",
      "/admin/timetable",
      "/admin/lessons",
      "/admin/students",
      "/admin/teachers",
      "/admin/groups",
      "/admin/levels",
      "/admin/settings",
    ]);
    // The teacher lesson log (CARM-35) ships ahead of the rest of P2.
    expect(navigationFor("TEACHER", 0).map((i) => i.href)).toEqual([
      "/teacher",
      "/teacher/timetable",
      "/teacher/lessons",
    ]);
    // The student Homework tab (CARM-36) too.
    expect(navigationFor("STUDENT", 0).map((i) => i.href)).toEqual([
      "/student",
      "/student/timetable",
      "/student/homework",
    ]);
  });

  it("adds items as phases ship", () => {
    expect(navigationFor("ADMIN", 1).map((i) => i.label)).toEqual([
      "dashboard",
      "timetable",
      "lessonLog",
      "students",
      "teachers",
      "courses",
      "levels",
      "settings",
    ]);
  });

  it("keeps every link inside the role's own area", () => {
    for (const [role, home] of [
      ["ADMIN", "/admin"],
      ["TEACHER", "/teacher"],
      ["STUDENT", "/student"],
    ] as const) {
      for (const item of navigationFor(role, 99)) {
        expect(item.href.startsWith(home)).toBe(true);
      }
    }
  });
});

describe("groupNavigation", () => {
  it("groups by section and pins settings", () => {
    const { groups, pinned } = groupNavigation(navigationFor("ADMIN", 1));
    expect(groups.map((g) => g.section)).toEqual([
      null,
      "schedule",
      "people",
      "academics",
    ]);
    expect(pinned.map((i) => i.label)).toEqual(["settings"]);
  });
});

describe("studentTabs", () => {
  it("is hidden while there is a single destination", () => {
    expect(studentTabs(navigationFor("STUDENT", 0).slice(0, 1))).toEqual({
      tabs: [],
      more: false,
    });
  });

  it("shows up to four tabs plus More", () => {
    const { tabs, more } = studentTabs(navigationFor("STUDENT", 6));
    expect(tabs.map((t) => t.label)).toEqual([
      "home",
      "timetable",
      "homework",
      "absences",
    ]);
    expect(more).toBe(true);
  });
});

describe("isActiveHref", () => {
  const items = navigationFor("ADMIN", 4);

  it("marks the longest matching item", () => {
    expect(isActiveHref("/admin", "/admin", items)).toBe(true);
    expect(
      isActiveHref("/admin/timetable", "/admin/timetable/generate", items),
    ).toBe(false);
    expect(
      isActiveHref(
        "/admin/timetable/generate",
        "/admin/timetable/generate",
        items,
      ),
    ).toBe(true);
    expect(isActiveHref("/admin", "/admin/students/1", items)).toBe(false);
  });
});
