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

describe("zonedTimeToUtc around DST switches (Europe/Bratislava)", () => {
  const tz = "Europe/Bratislava";
  // Spring forward: 2027-03-28 02:00 CET jumps to 03:00 CEST.
  it("shifts non-existent times in the spring-forward gap forward", () => {
    expect(zonedTimeToUtc("2027-03-28", 1 * 60, tz).toISOString()).toBe(
      "2027-03-28T00:00:00.000Z", // 01:00 CET
    );
    expect(zonedTimeToUtc("2027-03-28", 2 * 60, tz).toISOString()).toBe(
      "2027-03-28T01:00:00.000Z", // 02:00 → 03:00 CEST
    );
    expect(zonedTimeToUtc("2027-03-28", 2 * 60 + 30, tz).toISOString()).toBe(
      "2027-03-28T01:30:00.000Z", // 02:30 → 03:30 CEST
    );
    // 03:00 is real and equals the shifted 02:00 — a 02:00–03:00 window
    // collapses, which is why lesson end times are derived from the duration.
    expect(zonedTimeToUtc("2027-03-28", 3 * 60, tz).toISOString()).toBe(
      "2027-03-28T01:00:00.000Z",
    );
  });

  it("resolves ambiguous fall-back times to the later (standard-time) instant", () => {
    // 2026-10-25 03:00 CEST falls back to 02:00 CET; 02:30 happens twice.
    expect(zonedTimeToUtc("2026-10-25", 2 * 60 + 30, tz).toISOString()).toBe(
      "2026-10-25T01:30:00.000Z", // 02:30 CET
    );
  });
});
