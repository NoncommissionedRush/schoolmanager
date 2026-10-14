import { describe, expect, it } from "vitest";

import {
  gridHours,
  gridWeekdays,
  isMemberAt,
  layoutColumn,
  type LessonRecord,
  membersAt,
  mondayOf,
  parseIsoDateParam,
  resolveWeek,
  toLessonView,
} from "./week";

const TZ = "Europe/Bratislava";

const lesson = (extra: Partial<LessonRecord> = {}): LessonRecord => ({
  id: "lesson-1",
  termId: "term-1",
  timetableSlotId: "slot-1",
  // Monday 2026-10-19, 17:00–18:30 in Bratislava (UTC+2).
  startsAt: new Date("2026-10-19T15:00:00Z"),
  endsAt: new Date("2026-10-19T16:30:00Z"),
  status: "SCHEDULED",
  cancelReason: null,
  group: { id: "g1", name: "B1 Evening", type: "GROUP", level: { code: "B1" } },
  teacher: { id: "t1", name: "Tomas Horvat" },
  substitute: null,
  room: { id: "r1", name: "Room 3", kind: "PHYSICAL", meetingUrl: null },
  students: [
    { id: "s2", name: "Zora" },
    { id: "s1", name: "Adam" },
  ],
  ...extra,
});

describe("week resolution", () => {
  it("finds the Monday of any day", () => {
    expect(mondayOf("2026-10-19")).toBe("2026-10-19");
    expect(mondayOf("2026-10-25")).toBe("2026-10-19");
    expect(mondayOf("2026-10-14")).toBe("2026-10-12");
  });

  it("uses the URL week, or today's week when invalid", () => {
    expect(resolveWeek("2026-10-22", "2026-10-14")).toBe("2026-10-19");
    expect(resolveWeek(undefined, "2026-10-14")).toBe("2026-10-12");
    expect(resolveWeek("2026-02-30", "2026-10-14")).toBe("2026-10-12");
    expect(resolveWeek("next week", "2026-10-14")).toBe("2026-10-12");
  });

  it("parses date parameters strictly", () => {
    expect(parseIsoDateParam("2026-11-01", "x")).toBe("2026-11-01");
    expect(parseIsoDateParam("2026-13-01", "x")).toBe("x");
    expect(parseIsoDateParam(undefined, "x")).toBe("x");
  });
});

describe("toLessonView", () => {
  it("places the lesson in the school's time zone", () => {
    const view = toLessonView(lesson(), { kind: "ADMIN" }, TZ);
    expect(view).toMatchObject({
      date: "2026-10-19",
      startMinute: 17 * 60,
      endMinute: 18 * 60 + 30,
      level: "B1",
      teacherRole: null,
    });
  });

  it("keeps wall-clock times across the DST switch", () => {
    // Monday 2026-10-26 17:00 is UTC+1 after the October change.
    const view = toLessonView(
      lesson({
        startsAt: new Date("2026-10-26T16:00:00Z"),
        endsAt: new Date("2026-10-26T17:30:00Z"),
      }),
      { kind: "ADMIN" },
      TZ,
    );
    expect(view.startMinute).toBe(17 * 60);
  });

  it("gives admins and teachers the students, sorted", () => {
    const view = toLessonView(
      lesson(),
      { kind: "TEACHER", teacherId: "t1" },
      TZ,
    );
    expect(view.students?.map((s) => s.name)).toEqual(["Adam", "Zora"]);
  });

  it("never gives students other students' names", () => {
    const view = toLessonView(lesson(), { kind: "STUDENT" }, TZ);
    expect(view.students).toBeNull();
    expect(JSON.stringify(view)).not.toContain("Zora");
  });

  it("tells a teacher whether they teach, substitute or are covered", () => {
    const sub = { id: "t2", name: "Ana" };
    expect(
      toLessonView(lesson(), { kind: "TEACHER", teacherId: "t1" }, TZ)
        .teacherRole,
    ).toBe("regular");
    expect(
      toLessonView(
        lesson({ substitute: sub }),
        { kind: "TEACHER", teacherId: "t2" },
        TZ,
      ).teacherRole,
    ).toBe("substituting");
    expect(
      toLessonView(
        lesson({ substitute: sub }),
        { kind: "TEACHER", teacherId: "t1" },
        TZ,
      ).teacherRole,
    ).toBe("covered");
  });

  it("marks online rooms and keeps their meeting link", () => {
    const view = toLessonView(
      lesson({
        room: {
          id: "r2",
          name: "Online 1",
          kind: "ONLINE",
          meetingUrl: "https://meet.example/abc",
        },
      }),
      { kind: "STUDENT" },
      TZ,
    );
    expect(view.room).toEqual({
      id: "r2",
      name: "Online 1",
      online: true,
      meetingUrl: "https://meet.example/abc",
    });
  });
});

describe("membership windows", () => {
  const joined = new Date("2026-10-01T00:00:00Z");
  const left = new Date("2026-11-01T00:00:00Z");
  const memberships = [{ groupId: "g1", joinedAt: joined, leftAt: left }];

  it("shows lessons from joining until leaving", () => {
    expect(
      isMemberAt(memberships, "g1", new Date("2026-09-30T10:00:00Z")),
    ).toBe(false);
    expect(
      isMemberAt(memberships, "g1", new Date("2026-10-01T10:00:00Z")),
    ).toBe(true);
    expect(
      isMemberAt(memberships, "g1", new Date("2026-11-01T10:00:00Z")),
    ).toBe(false);
  });

  it("never shows another group's lessons", () => {
    expect(
      isMemberAt(memberships, "g2", new Date("2026-10-10T10:00:00Z")),
    ).toBe(false);
  });

  it("lists the members on a date", () => {
    const list = [
      { id: "a", joinedAt: joined, leftAt: null },
      { id: "b", joinedAt: joined, leftAt: left },
      { id: "c", joinedAt: left, leftAt: null },
    ];
    expect(
      membersAt(list, new Date("2026-11-05T10:00:00Z")).map((m) => m.id),
    ).toEqual(["a", "c"]);
  });
});

describe("layoutColumn", () => {
  const block = (id: string, start: number, end: number) => ({
    id,
    startMinute: start,
    endMinute: end,
  });

  it("gives non-overlapping blocks the full width", () => {
    const { placed, overflow } = layoutColumn([
      block("a", 600, 660),
      block("b", 660, 720), // back to back: no overlap
    ]);
    expect(placed).toEqual([
      { id: "a", lane: 0, lanes: 1 },
      { id: "b", lane: 0, lanes: 1 },
    ]);
    expect(overflow).toEqual([]);
  });

  it("splits overlapping blocks side by side", () => {
    const { placed } = layoutColumn([
      block("a", 600, 700),
      block("b", 630, 660),
      block("c", 680, 720),
    ]);
    expect(placed).toEqual([
      { id: "a", lane: 0, lanes: 2 },
      { id: "b", lane: 1, lanes: 2 },
      { id: "c", lane: 1, lanes: 2 },
    ]);
  });

  it("puts the fourth and later overlaps into '+N more'", () => {
    const { placed, overflow } = layoutColumn([
      block("a", 600, 660),
      block("b", 600, 660),
      block("c", 600, 660),
      block("d", 600, 660),
    ]);
    expect(placed.map((p) => p.id)).toEqual(["a", "b"]);
    expect(placed.every((p) => p.lanes === 3)).toBe(true);
    expect(overflow).toEqual([
      { ids: ["c", "d"], startMinute: 600, endMinute: 660, lane: 2, lanes: 3 },
    ]);
  });

  it("does not depend on input order", () => {
    const blocks = [
      block("a", 600, 700),
      block("b", 630, 660),
      block("c", 900, 960),
    ];
    expect(layoutColumn([...blocks].reverse())).toEqual(layoutColumn(blocks));
  });
});

describe("grid extent", () => {
  it("shows the school day widened to whole hours around every block", () => {
    const school = { dayStartMinute: 7 * 60, dayEndMinute: 21 * 60 };
    expect(gridHours(school, [])).toEqual({
      startMinute: 420,
      endMinute: 1260,
    });
    expect(
      gridHours(school, [
        { startMinute: 6 * 60 + 15, endMinute: 21 * 60 + 30 },
      ]),
    ).toEqual({ startMinute: 360, endMinute: 22 * 60 });
  });

  it("shows school days plus any day in use", () => {
    expect(gridWeekdays([1, 2, 3, 4, 5, 6], [7, 2])).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(gridWeekdays([1, 2, 3, 4, 5], [])).toEqual([1, 2, 3, 4, 5]);
  });
});
