import { describe, expect, it } from "vitest";

import { type SetupCounts, setupChecklist } from "./setup";

const none: SetupCounts = {
  terms: 0,
  rooms: 0,
  levels: 0,
  teachers: 0,
  students: 0,
  groupsWithMembers: 0,
  publishedTerms: 0,
};

describe("setup checklist (§3.1)", () => {
  it("lists the 7 steps in order, none done for a new school", () => {
    const checklist = setupChecklist(none);
    expect(checklist.steps.map((s) => [s.key, s.href, s.done])).toEqual([
      ["term", "/admin/settings/terms", false],
      ["rooms", "/admin/settings/rooms", false],
      ["levels", "/admin/levels", false],
      ["teachers", "/admin/teachers", false],
      ["students", "/admin/students", false],
      ["groups", "/admin/groups", false],
      ["timetable", "/admin/timetable", false],
    ]);
    expect(checklist).toMatchObject({ done: 0, total: 7, complete: false });
  });

  it("marks steps done in any order", () => {
    const checklist = setupChecklist({ ...none, levels: 6, students: 1 });
    expect(checklist.steps.filter((s) => s.done).map((s) => s.key)).toEqual([
      "levels",
      "students",
    ]);
    expect(checklist).toMatchObject({ done: 2, complete: false });
  });

  it("groups count only with members; timetable only when published", () => {
    const checklist = setupChecklist({ ...none, terms: 1 });
    expect(checklist.steps.find((s) => s.key === "groups")?.done).toBe(false);
    expect(checklist.steps.find((s) => s.key === "timetable")?.done).toBe(
      false,
    );
  });

  it("is complete when every step is done", () => {
    expect(
      setupChecklist({
        terms: 1,
        rooms: 3,
        levels: 5,
        teachers: 8,
        students: 40,
        groupsWithMembers: 10,
        publishedTerms: 1,
      }),
    ).toMatchObject({ done: 7, total: 7, complete: true });
  });
});
