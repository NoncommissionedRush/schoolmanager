import { describe, expect, it } from "vitest";

import { parseInput } from "../validation";
import { absenceSettingsSchema } from "./schema";

describe("absenceSettingsSchema", () => {
  it("stores the cutoff in minutes", () => {
    expect(
      parseInput(absenceSettingsSchema, { cutoffHours: "24", validDays: "30" }),
    ).toEqual({
      ok: true,
      data: { absenceCutoffMinutes: 1440, makeupCreditValidDays: 30 },
    });
  });

  it("accepts the edges: 0–336 hours, 1–365 days", () => {
    for (const [cutoffHours, validDays] of [
      ["0", "1"],
      ["336", "365"],
    ]) {
      expect(
        parseInput(absenceSettingsSchema, { cutoffHours, validDays }).ok,
      ).toBe(true);
    }
  });

  it("refuses values out of range, fractions and empty fields", () => {
    const result = parseInput(absenceSettingsSchema, {
      cutoffHours: "337",
      validDays: "1.5",
    });
    expect(result).toEqual({
      ok: false,
      fieldErrors: {
        cutoffHours: {
          key: "validation.integerRange",
          values: { min: 0, max: 336 },
        },
        validDays: {
          key: "validation.integerRange",
          values: { min: 1, max: 365 },
        },
      },
    });
    expect(
      parseInput(absenceSettingsSchema, { cutoffHours: "", validDays: "0" }).ok,
    ).toBe(false);
  });
});
