import { describe, expect, it } from "vitest";

import { parseInput } from "../validation";
import { isTimeZone, schoolSettingsSchema, timeZoneOptions } from "./schema";

const valid = {
  name: "Demo School",
  timezone: "Europe/Bratislava",
  teachingWeekdays: ["6", "1", "2", "3", "4", "5", "1"],
  dayStartMinute: "07:00",
  dayEndMinute: "21:00",
};

describe("school settings schema (§6.11)", () => {
  it("parses weekdays (sorted, unique) and hours as minutes", () => {
    expect(parseInput(schoolSettingsSchema, valid)).toEqual({
      ok: true,
      data: {
        name: "Demo School",
        timezone: "Europe/Bratislava",
        teachingWeekdays: [1, 2, 3, 4, 5, 6],
        dayStartMinute: 420,
        dayEndMinute: 1260,
      },
    });
  });

  it("accepts a single checked day", () => {
    const result = parseInput(schoolSettingsSchema, {
      ...valid,
      teachingWeekdays: "7",
    });
    expect(result.ok && result.data.teachingWeekdays).toEqual([7]);
  });

  it("requires at least one school day", () => {
    expect(
      parseInput(schoolSettingsSchema, {
        ...valid,
        teachingWeekdays: undefined,
      }),
    ).toEqual({
      ok: false,
      fieldErrors: {
        teachingWeekdays: { key: "settings.school.error.noDays" },
      },
    });
  });

  it("requires from < to", () => {
    for (const dayEndMinute of ["07:00", "06:30"]) {
      expect(
        parseInput(schoolSettingsSchema, { ...valid, dayEndMinute }),
      ).toEqual({
        ok: false,
        fieldErrors: { dayEndMinute: { key: "validation.timeOrder" } },
      });
    }
  });

  it("rejects unknown time zones", () => {
    expect(
      parseInput(schoolSettingsSchema, { ...valid, timezone: "Mars/Olympus" }),
    ).toEqual({
      ok: false,
      fieldErrors: { timezone: { key: "settings.school.error.timezone" } },
    });
    expect(isTimeZone("")).toBe(false);
  });

  it("offers IANA zones and keeps the current one", () => {
    expect(timeZoneOptions("Europe/Bratislava")).toContain("Europe/Bratislava");
    expect(timeZoneOptions("Etc/GMT+5")).toContain("Etc/GMT+5");
  });
});
