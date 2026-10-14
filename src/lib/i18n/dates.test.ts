import { describe, expect, it } from "vitest";
import {
  addDays,
  DEFAULT_WEEK_START,
  formatCalendarDate,
  formatTimeRange,
  formatWeekRange,
  orderedWeekdays,
  startOfWeek,
  toCalendarDate,
  weekDates,
  weekdayNames,
  weekdayOf,
} from "./dates";

describe("calendar dates", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("rejects malformed and impossible dates", () => {
    expect(() => weekdayOf("2026-13-01")).toThrow(RangeError);
    expect(() => weekdayOf("2026-02-30")).toThrow(RangeError);
    expect(() => weekdayOf("14.10.2026")).toThrow(RangeError);
  });

  it("knows the weekday of a date", () => {
    expect(weekdayOf("2026-10-14")).toBe(3); // Wednesday
    expect(weekdayOf("2026-10-18")).toBe(0); // Sunday
  });

  it("converts instants to the calendar day in the school's time zone", () => {
    const lateEvening = new Date("2026-10-14T22:30:00Z");
    expect(toCalendarDate(lateEvening, "UTC")).toBe("2026-10-14");
    expect(toCalendarDate(lateEvening, "Europe/Bratislava")).toBe("2026-10-15");
    expect(toCalendarDate(lateEvening, "America/New_York")).toBe("2026-10-14");
  });
});

describe("weeks", () => {
  it("start on Monday by default", () => {
    expect(DEFAULT_WEEK_START).toBe(1);
    expect(startOfWeek("2026-10-14")).toBe("2026-10-12");
    expect(startOfWeek("2026-10-12")).toBe("2026-10-12");
    expect(startOfWeek("2026-10-18")).toBe("2026-10-12");
  });

  it("can start on another day", () => {
    expect(startOfWeek("2026-10-14", 0)).toBe("2026-10-11");
    expect(startOfWeek("2026-10-17", 6)).toBe("2026-10-17");
  });

  it("lists the seven dates of a week", () => {
    expect(weekDates("2026-12-30")).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
    ]);
  });

  it("orders weekdays from the week start", () => {
    expect(orderedWeekdays()).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(orderedWeekdays(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("formatting (en-GB)", () => {
  it("names weekdays in display order", () => {
    expect(weekdayNames("en-GB", 1, "short")).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
    expect(weekdayNames("en-GB", 0)[0]).toBe("Sunday");
  });

  it("formats calendar dates independent of the runtime time zone", () => {
    expect(formatCalendarDate("en-GB", "2026-10-14")).toBe("14 Oct 2026");
  });

  it("formats week ranges", () => {
    // Intl separates multi-month ranges with thin spaces (U+2009).
    expect(formatWeekRange("en-GB", "2026-10-12")).toBe("12–18 Oct 2026");
    expect(formatWeekRange("en-GB", "2026-10-26")).toBe(
      "26 Oct\u2009–\u20091 Nov 2026",
    );
    expect(formatWeekRange("en-GB", "2026-12-28")).toBe(
      "28 Dec 2026\u2009–\u20093 Jan 2027",
    );
  });

  it("formats lesson times in the school's time zone, 24-hour clock", () => {
    const start = new Date("2026-10-14T07:30:00Z");
    const end = new Date("2026-10-14T09:00:00Z");
    expect(formatTimeRange("en-GB", start, end, "Europe/Bratislava")).toBe(
      "09:30–11:00",
    );
  });
});
