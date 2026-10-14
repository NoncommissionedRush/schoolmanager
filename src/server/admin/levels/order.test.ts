import { describe, expect, it } from "vitest";

import { cefrPreset, moveTarget, nextRank, planMove } from "./order";

const levels = [
  { id: "a1", rank: 1, archived: false },
  { id: "a2", rank: 2, archived: true },
  { id: "b1", rank: 3, archived: false },
  { id: "b2", rank: 5, archived: false },
];

describe("level reorder (§6.7)", () => {
  it("swaps with the nearest active neighbour, skipping archived levels", () => {
    expect(planMove(levels, "b1", "up")).toEqual([
      { id: "b1", rank: -1 },
      { id: "a1", rank: 3 },
      { id: "b1", rank: 1 },
    ]);
    expect(planMove(levels, "b1", "down")).toEqual([
      { id: "b1", rank: -1 },
      { id: "b2", rank: 3 },
      { id: "b1", rank: 5 },
    ]);
  });

  it("does nothing at the edges or for archived levels", () => {
    expect(planMove(levels, "a1", "up")).toEqual([]);
    expect(planMove(levels, "b2", "down")).toEqual([]);
    expect(planMove(levels, "a2", "up")).toEqual([]);
    expect(planMove(levels, "missing", "up")).toEqual([]);
    expect(moveTarget(levels, "a1", "down")?.id).toBe("b1");
  });

  it("never reuses a rank in any intermediate step", () => {
    const plan = planMove(levels, "b2", "up");
    const ranks = new Map(levels.map((l) => [l.id, l.rank]));
    for (const update of plan) {
      ranks.set(update.id, update.rank);
      expect(new Set(ranks.values()).size).toBe(ranks.size);
    }
    expect(ranks.get("b2")).toBe(3);
    expect(ranks.get("b1")).toBe(5);
  });

  it("picks a temporary rank below non-positive ranks too", () => {
    const plan = planMove(
      [
        { id: "x", rank: -3, archived: false },
        { id: "y", rank: 0, archived: false },
      ],
      "y",
      "up",
    );
    expect(plan[0]).toEqual({ id: "y", rank: -4 });
  });

  it("puts new levels last, after archived ones", () => {
    expect(nextRank([])).toBe(1);
    expect(nextRank(levels)).toBe(6);
  });
});

describe("CEFR preset", () => {
  const names = {
    A1: "Beginner",
    A2: "Elementary",
    B1: "Intermediate",
    B2: "Upper intermediate",
    C1: "Advanced",
    C2: "Proficiency",
  };

  it("adds A1–C2 in order on an empty school", () => {
    expect(cefrPreset([], names)).toEqual([
      { code: "A1", name: "Beginner", rank: 1 },
      { code: "A2", name: "Elementary", rank: 2 },
      { code: "B1", name: "Intermediate", rank: 3 },
      { code: "B2", name: "Upper intermediate", rank: 4 },
      { code: "C1", name: "Advanced", rank: 5 },
      { code: "C2", name: "Proficiency", rank: 6 },
    ]);
  });

  it("skips existing codes case-insensitively and goes after them", () => {
    expect(
      cefrPreset(
        [
          { code: "a1", rank: 1 },
          { code: "Kids", rank: 4 },
        ],
        names,
      ).map((l) => [l.code, l.rank]),
    ).toEqual([
      ["A2", 5],
      ["B1", 6],
      ["B2", 7],
      ["C1", 8],
      ["C2", 9],
    ]);
  });
});
