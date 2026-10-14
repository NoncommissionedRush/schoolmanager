import { describe, expect, it } from "vitest";

import { buildRoster } from "@/server/scheduling";

import {
  counterFrom,
  isStale,
  lessonBadge,
  logLock,
  logWrite,
  matchesFilter,
  parseLessonFilter,
  rosterCounts,
  teacherRelation,
} from "./rules";

const at = (time: string) => new Date(`2026-10-20T${time}:00Z`);
const lesson = (status: "SCHEDULED" | "CANCELLED" = "SCHEDULED") => ({
  startsAt: at("17:00"),
  endsAt: at("18:30"),
  status,
});

describe("logLock", () => {
  it("allows writing from the start time, with no end date (§12.2)", () => {
    expect(logLock(lesson(), at("16:59"))).toBe("notStarted");
    expect(logLock(lesson(), at("17:00"))).toBeNull();
    expect(logLock(lesson(), new Date("2027-06-01T00:00:00Z"))).toBeNull();
  });

  it("locks cancelled lessons", () => {
    expect(logLock(lesson("CANCELLED"), at("19:00"))).toBe("cancelled");
    expect(logLock(lesson("CANCELLED"), at("10:00"))).toBe("cancelled");
  });
});

describe("lessonBadge", () => {
  it("shows No log yet once an uncancelled lesson ended without content", () => {
    expect(lessonBadge(lesson(), null, at("18:00"))).toBeNull();
    expect(lessonBadge(lesson(), null, at("18:30"))).toBe("noLog");
    // Homework alone doesn't count as a log.
    expect(lessonBadge(lesson(), { content: null }, at("19:00"))).toBe("noLog");
    expect(lessonBadge(lesson(), { content: "Unit 4" }, at("19:00"))).toBe(
      null,
    );
  });

  it("shows Cancelled for cancelled lessons, log or not", () => {
    expect(lessonBadge(lesson("CANCELLED"), null, at("19:00"))).toBe(
      "cancelled",
    );
    expect(
      lessonBadge(lesson("CANCELLED"), { content: "x" }, at("10:00")),
    ).toBe("cancelled");
  });
});

describe("teacherRelation", () => {
  it.each([
    [{ teacherId: "a", substituteTeacherId: null }, "a", "regular"],
    [{ teacherId: "a", substituteTeacherId: "b" }, "b", "substituting"],
    [{ teacherId: "a", substituteTeacherId: "b" }, "a", "covered"],
  ] as const)("%o seen by %s → %s", (l, teacher, relation) => {
    expect(teacherRelation(l, teacher)).toBe(relation);
  });
});

describe("logWrite", () => {
  it.each([
    [{ content: "a", homework: null }, false, "create"],
    [{ content: null, homework: "hw" }, false, "create"],
    [{ content: "a", homework: "hw" }, true, "update"],
    [{ content: null, homework: null }, true, "delete"],
    [{ content: null, homework: null }, false, "none"],
  ] as const)("%o (exists: %s) → %s", (texts, exists, write) => {
    expect(logWrite(texts, exists)).toBe(write);
  });
});

describe("isStale", () => {
  const updatedAt = new Date("2026-10-20T18:40:00.000Z");
  it("accepts the record the form was loaded with", () => {
    expect(isStale(null, null)).toBe(false);
    expect(isStale(updatedAt.toISOString(), { updatedAt })).toBe(false);
  });

  it("refuses when the record was created, changed or removed since", () => {
    expect(isStale(null, { updatedAt })).toBe(true);
    expect(isStale("2026-10-20T18:39:00.000Z", { updatedAt })).toBe(true);
    expect(isStale(updatedAt.toISOString(), null)).toBe(true);
  });
});

describe("matchesFilter", () => {
  it("splits lessons into no log / upcoming / past", () => {
    const now = at("19:00");
    const past = lesson();
    const upcoming = {
      ...lesson(),
      startsAt: at("20:00"),
      endsAt: at("21:00"),
    };
    expect(matchesFilter("noLog", past, null, now)).toBe(true);
    expect(matchesFilter("noLog", past, { content: "x" }, now)).toBe(false);
    expect(matchesFilter("noLog", lesson("CANCELLED"), null, now)).toBe(false);
    expect(matchesFilter("past", past, null, now)).toBe(true);
    expect(matchesFilter("upcoming", past, null, now)).toBe(false);
    expect(matchesFilter("upcoming", upcoming, null, now)).toBe(true);
    expect(matchesFilter("noLog", upcoming, null, now)).toBe(false);
  });

  it("defaults to No log yet", () => {
    expect(parseLessonFilter(undefined)).toBe("noLog");
    expect(parseLessonFilter("past")).toBe("past");
    expect(parseLessonFilter("everything")).toBe("noLog");
  });
});

it("shows counters from 90 % of the limit", () => {
  expect(counterFrom(5000)).toBe(4500);
  expect(counterFrom(2000)).toBe(1800);
});

describe("rosterCounts (absences.md §6.3)", () => {
  const student = (id: string) => ({ id, name: id.toUpperCase() });
  const absence = (studentId: string, hasCredit = true) => ({
    studentId,
    reportedAt: at("10:00"),
    reason: null,
    viaOffice: false,
    hasCredit,
  });

  it("counts absent members and late-cancelled bookings as not coming", () => {
    const roster = buildRoster({
      members: ["a", "b", "c"].map(student),
      absences: [absence("a"), absence("b", false)],
      replacements: [{ ...student("r"), fromGroup: "B1 Morning" }],
      lateCancelled: [{ ...student("l"), cancelledAt: at("16:00") }],
    });
    expect(rosterCounts(roster)).toEqual({ notComing: 3, replacements: 1 });
  });

  it("is zero for a lesson everyone attends", () => {
    const roster = buildRoster({
      members: ["a", "b"].map(student),
      absences: [],
      replacements: [],
    });
    expect(rosterCounts(roster)).toEqual({ notComing: 0, replacements: 0 });
  });

  it("ignores absences of students who aren't members", () => {
    const roster = buildRoster({
      members: [student("a")],
      absences: [absence("gone")],
      replacements: [],
    });
    expect(rosterCounts(roster)).toEqual({ notComing: 0, replacements: 0 });
  });
});
