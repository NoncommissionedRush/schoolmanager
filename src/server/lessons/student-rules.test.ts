import { describe, expect, it } from "vitest";

import {
  canStudentSeeLesson,
  groupByMonth,
  HOMEWORK_MAX_SHOWN,
  parseShown,
  pickLatestHomework,
} from "./student-rules";

const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-20T12:00:00Z");

describe("parseShown", () => {
  it("defaults to one page and rounds up to whole pages", () => {
    expect(parseShown(undefined)).toBe(20);
    expect(parseShown("nonsense")).toBe(20);
    expect(parseShown("-5")).toBe(20);
    expect(parseShown("40")).toBe(40);
    expect(parseShown("41")).toBe(60);
  });

  it("is capped", () => {
    expect(parseShown("999999")).toBe(HOMEWORK_MAX_SHOWN);
  });
});

describe("canStudentSeeLesson", () => {
  const memberships = [
    // Joined mid-term, still a member.
    { groupId: "g1", joinedAt: at("2026-10-01T00:00:00Z"), leftAt: null },
    // Left on 16 Oct.
    {
      groupId: "g2",
      joinedAt: at("2026-09-01T00:00:00Z"),
      leftAt: at("2026-10-16T00:00:00Z"),
    },
  ];
  const lesson = (groupId: string, startsAt: string, published = true) => ({
    groupId,
    startsAt: at(startsAt),
    published,
  });

  it("allows started lessons of their groups while they were a member", () => {
    expect(
      canStudentSeeLesson(
        memberships,
        lesson("g1", "2026-10-13T15:00:00Z"),
        NOW,
      ),
    ).toBe(true);
    expect(
      canStudentSeeLesson(
        memberships,
        lesson("g2", "2026-10-15T15:00:00Z"),
        NOW,
      ),
    ).toBe(true);
  });

  it("refuses lessons before joining or after leaving", () => {
    expect(
      canStudentSeeLesson(
        memberships,
        lesson("g1", "2026-09-29T15:00:00Z"),
        NOW,
      ),
    ).toBe(false);
    expect(
      canStudentSeeLesson(
        memberships,
        lesson("g2", "2026-10-19T15:00:00Z"),
        NOW,
      ),
    ).toBe(false);
  });

  it("allows another group's lesson only while booked onto it as a replacement", () => {
    const booked = { id: "l9", ...lesson("g3", "2026-10-13T15:00:00Z") };
    expect(canStudentSeeLesson(memberships, booked, NOW, ["l9"])).toBe(true);
    // Not booked (rejected, cancelled or moved): no access.
    expect(canStudentSeeLesson(memberships, booked, NOW, [])).toBe(false);
    // A booking gives no access before the lesson starts or when unpublished.
    expect(
      canStudentSeeLesson(
        memberships,
        { ...booked, startsAt: at("2026-10-21T15:00:00Z") },
        NOW,
        ["l9"],
      ),
    ).toBe(false);
    expect(
      canStudentSeeLesson(memberships, { ...booked, published: false }, NOW, [
        "l9",
      ]),
    ).toBe(false);
  });

  it("refuses other groups, future lessons and unpublished terms", () => {
    expect(
      canStudentSeeLesson(
        memberships,
        lesson("g3", "2026-10-13T15:00:00Z"),
        NOW,
      ),
    ).toBe(false);
    expect(
      canStudentSeeLesson(
        memberships,
        lesson("g1", "2026-10-20T12:00:01Z"),
        NOW,
      ),
    ).toBe(false);
    expect(
      canStudentSeeLesson(
        memberships,
        lesson("g1", "2026-10-13T15:00:00Z", false),
        NOW,
      ),
    ).toBe(false);
  });

  it("counts a lesson as started at its start time", () => {
    expect(
      canStudentSeeLesson(
        memberships,
        lesson("g1", "2026-10-20T12:00:00Z"),
        NOW,
      ),
    ).toBe(true);
  });

  it("refuses everything without memberships", () => {
    expect(
      canStudentSeeLesson([], lesson("g1", "2026-10-13T15:00:00Z"), NOW),
    ).toBe(false);
  });
});

describe("groupByMonth", () => {
  it("groups consecutive items by month, keeping the order", () => {
    const groups = groupByMonth([
      { date: "2026-10-20" },
      { date: "2026-10-01" },
      { date: "2026-09-30" },
    ]);
    expect(groups).toEqual([
      {
        month: "2026-10",
        items: [{ date: "2026-10-20" }, { date: "2026-10-01" }],
      },
      { month: "2026-09", items: [{ date: "2026-09-30" }] },
    ]);
  });

  it("is empty for no items", () => {
    expect(groupByMonth([])).toEqual([]);
  });
});

describe("pickLatestHomework", () => {
  const item = (id: string, startsAt: string, homework: string | null) => ({
    id,
    startsAt: at(startsAt),
    homework,
  });

  it("keeps groups whose last lesson set homework, newest first, up to 3", () => {
    const picked = pickLatestHomework([
      item("a", "2026-10-13T15:00:00Z", "Essay"),
      null,
      item("b", "2026-10-15T15:00:00Z", null),
      item("c", "2026-10-19T15:00:00Z", "Workbook p. 34"),
      item("d", "2026-10-14T15:00:00Z", "Read chapter 2"),
      item("e", "2026-10-12T15:00:00Z", "Vocabulary"),
    ]);
    expect(picked.map((p) => p.id)).toEqual(["c", "d", "a"]);
  });
});
