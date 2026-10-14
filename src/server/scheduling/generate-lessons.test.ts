import { describe, expect, it } from "vitest";

import {
  generateLessonOccurrences,
  type SlotTemplate,
  slotOccurrenceDates,
} from "./generate-lessons";

const monday: SlotTemplate = {
  id: "slot-mon",
  groupId: "g1",
  teacherId: "t1",
  roomId: "r1",
  weekday: 1,
  startMinute: 9 * 60,
  endMinute: 10 * 60 + 30,
};
const wednesday: SlotTemplate = { ...monday, id: "slot-wed", weekday: 3 };

// 2026-10-12 is a Monday; DST ends 2026-10-25.
const term = { startDate: "2026-10-12", endDate: "2026-11-01" };
const timeZone = "Europe/Bratislava";

describe("generateLessonOccurrences", () => {
  it("creates one lesson per matching weekday in the term", () => {
    const lessons = generateLessonOccurrences({
      slots: [monday, wednesday],
      term,
      holidays: [],
      timeZone,
    });
    expect(lessons.map((l) => `${l.timetableSlotId}@${l.date}`)).toEqual([
      "slot-mon@2026-10-12",
      "slot-wed@2026-10-14",
      "slot-mon@2026-10-19",
      "slot-wed@2026-10-21",
      "slot-mon@2026-10-26",
      "slot-wed@2026-10-28",
    ]);
  });

  it("skips holidays (inclusive ranges)", () => {
    const lessons = generateLessonOccurrences({
      slots: [monday, wednesday],
      term,
      holidays: [{ startDate: "2026-10-19", endDate: "2026-10-21" }],
      timeZone,
    });
    expect(lessons.map((l) => l.date)).toEqual([
      "2026-10-12",
      "2026-10-14",
      "2026-10-26",
      "2026-10-28",
    ]);
  });

  it("keeps the local wall-clock time across a DST change", () => {
    const [before, , after] = generateLessonOccurrences({
      slots: [monday],
      term,
      holidays: [],
      timeZone,
    });
    expect(before.startsAt.toISOString()).toBe("2026-10-12T07:00:00.000Z");
    expect(before.endsAt.toISOString()).toBe("2026-10-12T08:30:00.000Z");
    expect(after.startsAt.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });

  it("keeps the slot duration for a slot inside the spring-forward gap", () => {
    // 2027-03-28 is a Sunday; 02:00–03:00 local does not exist that night.
    const [lesson] = generateLessonOccurrences({
      slots: [
        { ...monday, weekday: 7, startMinute: 2 * 60, endMinute: 3 * 60 },
      ],
      term: { startDate: "2027-03-28", endDate: "2027-03-28" },
      holidays: [],
      timeZone,
    });
    expect(lesson.date).toBe("2027-03-28");
    expect(lesson.startsAt.toISOString()).toBe("2027-03-28T01:00:00.000Z");
    expect(lesson.endsAt.toISOString()).toBe("2027-03-28T02:00:00.000Z");
  });

  it("keeps the slot duration across the fall-back overlap", () => {
    // 2026-10-25 is a Sunday; 02:00–03:00 CEST/CET overlap that night.
    const [lesson] = generateLessonOccurrences({
      slots: [
        { ...monday, weekday: 7, startMinute: 2 * 60, endMinute: 3 * 60 },
      ],
      term: { startDate: "2026-10-25", endDate: "2026-10-25" },
      holidays: [],
      timeZone,
    });
    expect(lesson.endsAt.getTime() - lesson.startsAt.getTime()).toBe(
      60 * 60_000,
    );
  });

  it("clips an explicit range to the term", () => {
    const lessons = generateLessonOccurrences({
      slots: [monday],
      term,
      holidays: [],
      timeZone,
      range: { startDate: "2026-01-01", endDate: "2026-10-18" },
    });
    expect(lessons.map((l) => l.date)).toEqual(["2026-10-12"]);
  });

  it("copies group, teacher and room from the slot", () => {
    const [lesson] = generateLessonOccurrences({
      slots: [monday],
      term,
      holidays: [],
      timeZone,
    });
    expect(lesson).toMatchObject({
      groupId: "g1",
      teacherId: "t1",
      roomId: "r1",
    });
  });

  it("only generates lessons while the slot is in effect", () => {
    const lessons = generateLessonOccurrences({
      slots: [
        { ...monday, validUntil: "2026-10-19" },
        { ...wednesday, validFrom: "2026-10-27" },
      ],
      term,
      holidays: [],
      timeZone,
    });
    expect(lessons.map((l) => `${l.timetableSlotId}@${l.date}`)).toEqual([
      "slot-mon@2026-10-12",
      "slot-mon@2026-10-19",
      "slot-wed@2026-10-28",
    ]);
  });
});

describe("slotOccurrenceDates", () => {
  it("lists the slot's weekday within term and validity, minus holidays", () => {
    expect(
      slotOccurrenceDates(
        { weekday: 3, validFrom: "2026-10-14", validUntil: null },
        term,
        [{ startDate: "2026-10-21", endDate: "2026-10-21" }],
      ),
    ).toEqual(["2026-10-14", "2026-10-28"]);
    expect(
      slotOccurrenceDates(
        { weekday: 3, validFrom: "2026-10-30", validUntil: "2026-10-29" },
        term,
        [],
      ),
    ).toEqual([]);
  });
});
