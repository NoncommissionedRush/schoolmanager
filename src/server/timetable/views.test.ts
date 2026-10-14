import { describe, expect, it } from "vitest";

import { membershipLessonWhere } from "./views";

describe("membershipLessonWhere", () => {
  it("limits each group to the student's membership window", () => {
    const joined = new Date("2026-09-01T00:00:00Z");
    const left = new Date("2026-10-01T00:00:00Z");
    expect(
      membershipLessonWhere([
        { groupId: "g1", joinedAt: joined, leftAt: left },
        { groupId: "g2", joinedAt: left, leftAt: null },
      ]),
    ).toEqual({
      OR: [
        { groupId: "g1", startsAt: { gte: joined, lt: left } },
        { groupId: "g2", startsAt: { gte: left } },
      ],
    });
  });

  it("matches nothing for a student in no group", () => {
    expect(membershipLessonWhere([])).toEqual({ id: { in: [] } });
  });
});
