import { describe, expect, it } from "vitest";

import { parseInput } from "../validation";
import {
  hoursToMinutes,
  levelRangeLabel,
  levelsUpTo,
  minutesToHours,
  teacherLevelsSchema,
} from "./levels";

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"].map((code, i) => ({
  id: id(i + 1),
  code,
}));

describe("levelRangeLabel", () => {
  it("collapses consecutive levels by rank", () => {
    expect(levelRangeLabel(LEVELS, [id(1), id(2), id(3), id(4)])).toBe("A1–B2");
    expect(levelRangeLabel(LEVELS, [id(6), id(1), id(5)])).toBe("A1, C1–C2");
    expect(levelRangeLabel(LEVELS, [id(3)])).toBe("B1");
    expect(levelRangeLabel(LEVELS, [])).toBe("");
    expect(levelRangeLabel(LEVELS, ["unknown"])).toBe("");
  });
});

describe("levelsUpTo", () => {
  it("ticks every level up to the chosen one", () => {
    expect(levelsUpTo(LEVELS, id(3))).toEqual([id(1), id(2), id(3)]);
    expect(levelsUpTo(LEVELS, "unknown")).toEqual([]);
  });
});

describe("teacherLevelsSchema", () => {
  it("accepts levels and an optional maximum in quarter hours", () => {
    expect(
      parseInput(teacherLevelsSchema, {
        levelIds: [id(1), id(2), id(1)],
        maxHours: 7.5,
      }),
    ).toEqual({ ok: true, data: { levelIds: [id(1), id(2)], maxHours: 7.5 } });
    expect(
      parseInput(teacherLevelsSchema, { levelIds: [], maxHours: null }).ok,
    ).toBe(true);
  });

  it("refuses hours outside 0.25–100 or off the quarter hour", () => {
    for (const maxHours of [0, 0.1, 7.3, 101, Number.NaN]) {
      expect(
        parseInput(teacherLevelsSchema, { levelIds: [], maxHours }),
      ).toEqual({
        ok: false,
        fieldErrors: {
          maxHours: {
            key: "validation.hoursRange",
            values: { min: 0.25, max: 100 },
          },
        },
      });
    }
  });

  it("refuses malformed level ids", () => {
    expect(
      parseInput(teacherLevelsSchema, { levelIds: ["x"], maxHours: null }).ok,
    ).toBe(false);
  });
});

describe("hours and minutes", () => {
  it("round-trips the stored minutes", () => {
    expect(hoursToMinutes(7.5)).toBe(450);
    expect(hoursToMinutes(null)).toBeNull();
    expect(minutesToHours(450)).toBe(7.5);
    expect(minutesToHours(null)).toBeNull();
    // The CHECK bounds (15–6000 minutes).
    expect(hoursToMinutes(0.25)).toBe(15);
    expect(hoursToMinutes(100)).toBe(6000);
  });
});
