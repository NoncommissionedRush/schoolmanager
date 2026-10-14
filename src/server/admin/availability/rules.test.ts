import { describe, expect, it } from "vitest";

import {
  affectedLessons,
  availableExceptionHasNoEffect,
  expandDateRange,
  MAX_EXCEPTION_DAYS,
  mergeWeekly,
} from "./rules";

const row = (id: string, start: string, end: string, note = null) => ({
  id,
  startMinute: minutes(start),
  endMinute: minutes(end),
  note,
});
function minutes(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

describe("mergeWeekly", () => {
  it("keeps a window that touches nothing as is", () => {
    const merged = mergeWeekly([row("a", "13:00", "15:00")], {
      startMinute: minutes("07:00"),
      endMinute: minutes("12:00"),
      note: "School run",
    });
    expect(merged).toEqual({
      startMinute: minutes("07:00"),
      endMinute: minutes("12:00"),
      note: "School run",
      absorbedIds: [],
    });
  });

  it("merges an overlapping rule into one window", () => {
    const merged = mergeWeekly([row("a", "09:00", "13:00")], {
      startMinute: minutes("07:00"),
      endMinute: minutes("10:00"),
      note: null,
    });
    expect(merged.startMinute).toBe(minutes("07:00"));
    expect(merged.endMinute).toBe(minutes("13:00"));
    expect(merged.absorbedIds).toEqual(["a"]);
  });

  it("merges touching windows (07–09 + 09–12 = 07–12)", () => {
    const merged = mergeWeekly([row("a", "09:00", "12:00")], {
      startMinute: minutes("07:00"),
      endMinute: minutes("09:00"),
      note: null,
    });
    expect([merged.startMinute, merged.endMinute]).toEqual([
      minutes("07:00"),
      minutes("12:00"),
    ]);
  });

  it("cascades when the grown window reaches further rules", () => {
    // 10–12 bridges 08–10:30 and 11:30–14, which reach 14–15 as well.
    const merged = mergeWeekly(
      [
        row("late", "14:00", "15:00"),
        row("early", "08:00", "10:30"),
        row("mid", "11:30", "14:00"),
        row("evening", "18:00", "19:00"),
      ],
      {
        startMinute: minutes("10:00"),
        endMinute: minutes("12:00"),
        note: null,
      },
    );
    expect([merged.startMinute, merged.endMinute]).toEqual([
      minutes("08:00"),
      minutes("15:00"),
    ]);
    expect(merged.absorbedIds.sort()).toEqual(["early", "late", "mid"]);
  });

  it("keeps the new note, else the first absorbed note", () => {
    const existing = [{ ...row("a", "09:00", "12:00"), note: "Old" }];
    const window = {
      startMinute: minutes("08:00"),
      endMinute: minutes("10:00"),
    };
    expect(mergeWeekly(existing, { ...window, note: "New" }).note).toBe("New");
    expect(mergeWeekly(existing, { ...window, note: null }).note).toBe("Old");
  });

  it("absorbs a rule contained in the new window", () => {
    const merged = mergeWeekly([row("a", "09:00", "10:00")], {
      startMinute: minutes("08:00"),
      endMinute: minutes("12:00"),
      note: null,
    });
    expect(merged.absorbedIds).toEqual(["a"]);
    expect(merged.endMinute).toBe(minutes("12:00"));
  });
});

describe("expandDateRange", () => {
  it("returns a single date without an end date", () => {
    expect(expandDateRange("2026-10-20", null)).toEqual(["2026-10-20"]);
  });

  it("expands an inclusive range across a month boundary", () => {
    expect(expandDateRange("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it(`allows at most ${MAX_EXCEPTION_DAYS} days`, () => {
    expect(expandDateRange("2026-10-01", "2026-10-31")).toHaveLength(31);
    expect(expandDateRange("2026-10-01", "2026-11-01")).toBeNull();
  });

  it("rejects a reversed range", () => {
    expect(expandDateRange("2026-10-20", "2026-10-19")).toBeNull();
  });
});

describe("availableExceptionHasNoEffect", () => {
  // Weekly unavailability on Mondays 07:00–12:00.
  const weekly = [
    { weekday: 1, startMinute: minutes("07:00"), endMinute: minutes("12:00") },
  ];

  it("warns on a day without a weekly rule", () => {
    // 2026-10-20 is a Tuesday.
    expect(availableExceptionHasNoEffect(["2026-10-20"], null, weekly)).toBe(
      true,
    );
  });

  it("does not warn when the weekday has a rule (whole day)", () => {
    // 2026-10-19 is a Monday.
    expect(availableExceptionHasNoEffect(["2026-10-19"], null, weekly)).toBe(
      false,
    );
  });

  it("warns when the time window misses the weekly rule", () => {
    const afternoon = {
      startMinute: minutes("14:00"),
      endMinute: minutes("16:00"),
    };
    expect(
      availableExceptionHasNoEffect(["2026-10-19"], afternoon, weekly),
    ).toBe(true);
  });

  it("does not warn when any date in a range has an effect", () => {
    expect(
      availableExceptionHasNoEffect(
        ["2026-10-18", "2026-10-19", "2026-10-20"],
        null,
        weekly,
      ),
    ).toBe(false);
  });

  it("does not warn before a date is entered", () => {
    expect(availableExceptionHasNoEffect([], null, weekly)).toBe(false);
  });
});

describe("affectedLessons", () => {
  const lessons = [
    { id: 1, date: "2026-10-19", startMinute: 540, endMinute: 630 },
    { id: 2, date: "2026-10-19", startMinute: 900, endMinute: 990 },
    { id: 3, date: "2026-10-20", startMinute: 540, endMinute: 630 },
  ];

  it("counts every lesson on the dates for a whole-day exception", () => {
    expect(
      affectedLessons(lessons, ["2026-10-19"], null).map((l) => l.id),
    ).toEqual([1, 2]);
  });

  it("only counts lessons overlapping the window", () => {
    const window = { startMinute: 600, endMinute: 720 };
    expect(
      affectedLessons(lessons, ["2026-10-19", "2026-10-20"], window).map(
        (l) => l.id,
      ),
    ).toEqual([1, 3]);
  });

  it("does not count a lesson that ends when the window starts", () => {
    const window = { startMinute: 630, endMinute: 700 };
    expect(affectedLessons(lessons, ["2026-10-19"], window)).toEqual([]);
  });
});
