import { describe, expect, it } from "vitest";

import {
  canChangeType,
  capacityError,
  groupsOfOtherLevel,
  isFull,
  joinableGroups,
  levelMismatch,
  pickable,
  placesLeft,
  planAddMembers,
  removalError,
  slotsOverlap,
  timeClash,
} from "./rules";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("capacity", () => {
  it("counts free places and never goes negative", () => {
    expect(placesLeft(10, 8)).toBe(2);
    expect(placesLeft(10, 10)).toBe(0);
    expect(placesLeft(3, 5)).toBe(0);
  });

  it("is full at or above capacity", () => {
    expect(isFull(10, 9)).toBe(false);
    expect(isFull(10, 10)).toBe(true);
    expect(isFull(1, 1)).toBe(true);
  });

  it("refuses a capacity below the member count", () => {
    expect(capacityError(8, 8)).toBeNull();
    expect(capacityError(10, 8)).toBeNull();
    expect(capacityError(5, 8)).toEqual({
      key: "groups.error.capacityBelowMembers",
      values: { count: 8 },
    });
  });

  it("locks the type once lessons exist", () => {
    expect(canChangeType(0)).toBe(true);
    expect(canChangeType(1)).toBe(false);
  });
});

describe("planAddMembers", () => {
  const existing = [
    { id: "m1", studentId: "s1", leftAt: null },
    { id: "m2", studentId: "s2", leftAt: day("2026-09-30") },
  ];

  it("creates new rows and reuses the row of a former member", () => {
    expect(
      planAddMembers({ capacity: 3, existing, requested: ["s2", "s3"] }),
    ).toEqual({
      ok: true,
      create: ["s3"],
      rejoin: [{ membershipId: "m2", studentId: "s2" }],
    });
  });

  it("never overfills (former members don't count)", () => {
    expect(
      planAddMembers({ capacity: 2, existing, requested: ["s3"] }),
    ).toMatchObject({ ok: true });
    expect(
      planAddMembers({ capacity: 2, existing, requested: ["s2", "s3"] }),
    ).toEqual({ ok: false, error: { key: "groups.members.full" } });
    expect(
      planAddMembers({ capacity: 1, existing, requested: ["s3"] }),
    ).toEqual({ ok: false, error: { key: "groups.members.full" } });
  });

  it("ignores duplicate ids in the request", () => {
    expect(
      planAddMembers({ capacity: 2, existing, requested: ["s3", "s3"] }),
    ).toEqual({ ok: true, create: ["s3"], rejoin: [] });
  });

  it("rejects current members and empty requests", () => {
    expect(
      planAddMembers({ capacity: 5, existing, requested: ["s1"] }),
    ).toEqual({ ok: false, error: { key: "groups.members.alreadyMember" } });
    expect(planAddMembers({ capacity: 5, existing, requested: [] })).toEqual({
      ok: false,
      error: { key: "groups.members.noneSelected" },
    });
  });
});

describe("removalError", () => {
  const today = day("2026-10-14");
  const joinedAt = new Date("2026-09-14T08:30:00Z");

  it("allows a last day between joining and today", () => {
    expect(
      removalError({ joinedAt, leftAt: null, date: today, today }),
    ).toBeNull();
    expect(
      removalError({ joinedAt, leftAt: null, date: day("2026-09-14"), today }),
    ).toBeNull();
  });

  it("rejects dates before joining or in the future", () => {
    expect(
      removalError({ joinedAt, leftAt: null, date: day("2026-09-13"), today }),
    ).toEqual({ key: "groups.members.leftBeforeJoined" });
    expect(
      removalError({ joinedAt, leftAt: null, date: day("2026-10-15"), today }),
    ).toEqual({ key: "groups.members.leftInFuture" });
  });

  it("rejects a membership that already ended", () => {
    expect(
      removalError({ joinedAt, leftAt: day("2026-10-01"), date: today, today }),
    ).toEqual({ key: "groups.members.notMember" });
  });
});

describe("level mismatch", () => {
  it("warns only for a student with another level", () => {
    expect(levelMismatch("b1", "b1")).toBe(false);
    expect(levelMismatch("b2", "b1")).toBe(true);
    expect(levelMismatch(null, "b1")).toBe(false);
  });

  it("lists the current groups of another level", () => {
    const groups = [
      { name: "B1 Evening", levelId: "b1", levelCode: "B1" },
      { name: "B2 Late", levelId: "b2", levelCode: "B2" },
    ];
    expect(groupsOfOtherLevel("b1", groups).map((g) => g.name)).toEqual([
      "B2 Late",
    ]);
    expect(groupsOfOtherLevel(null, groups)).toEqual([]);
  });
});

describe("time clash", () => {
  const slot = { termId: "t", weekday: 1, startMinute: 540, endMinute: 630 };

  it("overlaps only in the same term and weekday", () => {
    expect(
      slotsOverlap(slot, { ...slot, startMinute: 600, endMinute: 690 }),
    ).toBe(true);
    expect(
      slotsOverlap(slot, { ...slot, startMinute: 630, endMinute: 720 }),
    ).toBe(false);
    expect(slotsOverlap(slot, { ...slot, weekday: 2 })).toBe(false);
    expect(slotsOverlap(slot, { ...slot, termId: "other" })).toBe(false);
  });

  it("names the first clashing group", () => {
    expect(
      timeClash(
        [slot],
        [
          { ...slot, weekday: 3, groupName: "A" },
          { ...slot, startMinute: 560, groupName: "B" },
        ],
      ),
    ).toBe("B");
    expect(timeClash([slot], [])).toBeNull();
  });
});

describe("pickers", () => {
  const archived = new Date();
  const levels = [
    { id: "a1", archivedAt: null },
    { id: "c2", archivedAt: archived },
  ];

  it("hides archived records except the current value", () => {
    expect(pickable(levels).map((l) => l.id)).toEqual(["a1"]);
    expect(pickable(levels, "c2").map((l) => l.id)).toEqual(["a1", "c2"]);
  });

  const group = (id: string, levelId: string, members: number) => ({
    id,
    name: id,
    capacity: 2,
    levelId,
    levelCode: levelId.toUpperCase(),
    members,
  });
  const groups = [
    group("g1", "b1", 1),
    group("g2", "b1", 2),
    group("g3", "b2", 0),
  ];

  it("offers groups with free places of the student's level", () => {
    const ids = (list: { id: string }[]) => list.map((g) => g.id);
    expect(
      ids(joinableGroups(groups, { levelId: "b1", showAll: false })),
    ).toEqual(["g1"]);
    expect(
      ids(joinableGroups(groups, { levelId: "b1", showAll: true })),
    ).toEqual(["g1", "g3"]);
    expect(
      ids(joinableGroups(groups, { levelId: null, showAll: false })),
    ).toEqual(["g1", "g3"]);
    expect(
      ids(
        joinableGroups(groups, {
          levelId: null,
          showAll: false,
          exclude: ["g1"],
        }),
      ),
    ).toEqual(["g3"]);
  });
});
