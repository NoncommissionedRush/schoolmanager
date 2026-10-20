import { describe, expect, it } from "vitest";

import { addDays, isoWeekday } from "../../src/server/scheduling/time";
import { BASE_TODAY, seedShiftDays } from "./clock";

describe("seedShiftDays", () => {
  it("keeps the seed as written in the week of BASE_TODAY", () => {
    for (let day = 0; day < 7; day++) {
      expect(seedShiftDays(addDays(BASE_TODAY, day))).toBe(0);
    }
  });

  it("moves to the latest Wednesday on or before the reference day", () => {
    for (const reference of [
      "2026-10-20",
      "2027-03-03",
      "2027-03-09",
      "2028-01-01",
      "2026-01-01",
    ]) {
      const shift = seedShiftDays(reference);
      const seedToday = addDays(BASE_TODAY, shift);
      expect(Math.abs(shift % 7)).toBe(0);
      expect(isoWeekday(seedToday)).toBe(3);
      expect(seedToday <= reference).toBe(true);
      expect(addDays(seedToday, 7) > reference).toBe(true);
    }
  });
});
