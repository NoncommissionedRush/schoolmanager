import { describe, expect, it } from "vitest";

import { addDays, formatMinutes, isoWeekday, zonedTimeToUtc } from "./time";

describe("isoWeekday", () => {
  it("returns 1 for Monday and 7 for Sunday", () => {
    expect(isoWeekday("2026-10-12")).toBe(1);
    expect(isoWeekday("2026-10-18")).toBe(7);
  });
});

describe("addDays", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("formatMinutes", () => {
  it("formats minutes since midnight as HH:MM", () => {
    expect(formatMinutes(9 * 60 + 5)).toBe("09:05");
    expect(formatMinutes(17 * 60 + 30)).toBe("17:30");
  });
});

describe("zonedTimeToUtc", () => {
  it("applies summer time (CEST, UTC+2)", () => {
    expect(
      zonedTimeToUtc("2026-10-14", 9 * 60, "Europe/Bratislava").toISOString(),
    ).toBe("2026-10-14T07:00:00.000Z");
  });

  it("applies winter time (CET, UTC+1) after the DST switch", () => {
    // DST ends on Sunday 2026-10-25.
    expect(
      zonedTimeToUtc("2026-10-26", 9 * 60, "Europe/Bratislava").toISOString(),
    ).toBe("2026-10-26T08:00:00.000Z");
  });

  it("is the identity for UTC", () => {
    expect(zonedTimeToUtc("2026-01-01", 90, "UTC").toISOString()).toBe(
      "2026-01-01T01:30:00.000Z",
    );
  });
});
