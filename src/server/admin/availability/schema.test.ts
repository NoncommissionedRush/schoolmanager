import { describe, expect, it } from "vitest";

import { parseInput } from "../validation";
import { exceptionSchema, weeklySchema } from "./schema";

describe("weeklySchema", () => {
  it("parses several weekdays and converts times to minutes", () => {
    const result = parseInput(weeklySchema, {
      weekdays: ["3", "1", "1"],
      from: "07:00",
      to: "12:30",
      note: "  School run  ",
    });
    expect(result).toEqual({
      ok: true,
      data: {
        weekdays: [1, 3],
        startMinute: 420,
        endMinute: 750,
        note: "School run",
      },
    });
  });

  it("accepts a single weekday (one checkbox) and an empty note", () => {
    const result = parseInput(weeklySchema, {
      weekdays: "5",
      from: "08:00",
      to: "09:00",
      note: "",
    });
    expect(result.ok && result.data).toMatchObject({
      weekdays: [5],
      note: null,
    });
  });

  it("requires at least one day", () => {
    const result = parseInput(weeklySchema, { from: "08:00", to: "09:00" });
    expect(!result.ok && result.fieldErrors.weekdays).toEqual({
      key: "validation.select",
      values: { field: { key: "availability.field.weekdays" } },
    });
  });

  it("requires from < to", () => {
    for (const to of ["08:00", "07:59"]) {
      const result = parseInput(weeklySchema, {
        weekdays: "1",
        from: "08:00",
        to,
      });
      expect(!result.ok && result.fieldErrors.to).toEqual({
        key: "validation.timeOrder",
      });
    }
  });

  it("rejects notes over 200 characters", () => {
    const result = parseInput(weeklySchema, {
      weekdays: "1",
      from: "08:00",
      to: "09:00",
      note: "x".repeat(201),
    });
    expect(!result.ok && result.fieldErrors.note?.key).toBe(
      "validation.maxLength",
    );
  });
});

describe("exceptionSchema", () => {
  const base = { kind: "DATE_UNAVAILABLE", date: "2026-10-20" };

  it("parses a whole-day exception on one date", () => {
    const result = parseInput(exceptionSchema, { ...base, wholeDay: "on" });
    expect(result).toEqual({
      ok: true,
      data: {
        kind: "DATE_UNAVAILABLE",
        dates: ["2026-10-20"],
        window: null,
        note: null,
      },
    });
  });

  it("expands a date range to one date per day", () => {
    const result = parseInput(exceptionSchema, {
      ...base,
      dateTo: "2026-10-22",
      wholeDay: "on",
    });
    expect(result.ok && result.data.dates).toEqual([
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
    ]);
  });

  it("rejects ranges longer than 31 days", () => {
    const result = parseInput(exceptionSchema, {
      ...base,
      dateTo: "2026-11-20",
      wholeDay: "on",
    });
    expect(!result.ok && result.fieldErrors.dateTo).toEqual({
      key: "availability.error.rangeTooLong",
    });
  });

  it("rejects an end date before the start date", () => {
    const result = parseInput(exceptionSchema, {
      ...base,
      dateTo: "2026-10-19",
      wholeDay: "on",
    });
    expect(!result.ok && result.fieldErrors.dateTo).toEqual({
      key: "validation.dateOrder",
    });
  });

  it("needs from/to with from < to when not whole day", () => {
    const missing = parseInput(exceptionSchema, { ...base, wholeDay: "" });
    expect(!missing.ok && Object.keys(missing.fieldErrors).sort()).toEqual([
      "from",
      "to",
    ]);
    const reversed = parseInput(exceptionSchema, {
      ...base,
      from: "12:00",
      to: "10:00",
    });
    expect(!reversed.ok && reversed.fieldErrors.to).toEqual({
      key: "validation.timeOrder",
    });
    const ok = parseInput(exceptionSchema, {
      ...base,
      kind: "DATE_AVAILABLE",
      from: "10:00",
      to: "12:00",
    });
    expect(ok.ok && ok.data).toMatchObject({
      kind: "DATE_AVAILABLE",
      window: { startMinute: 600, endMinute: 720 },
    });
  });

  it("ignores times on a whole-day exception", () => {
    const result = parseInput(exceptionSchema, {
      ...base,
      wholeDay: "on",
      from: "10:00",
      to: "09:00",
    });
    expect(result.ok && result.data.window).toBeNull();
  });

  it("requires a valid date and type", () => {
    const result = parseInput(exceptionSchema, {
      kind: "WEEKLY_UNAVAILABLE",
      date: "2026-02-30",
      wholeDay: "on",
    });
    expect(!result.ok && Object.keys(result.fieldErrors).sort()).toEqual([
      "date",
      "kind",
    ]);
  });
});
