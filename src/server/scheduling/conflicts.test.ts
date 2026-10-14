import { describe, expect, it } from "vitest";

import {
  CONFLICT_SEVERITY,
  CONFLICT_TYPES,
  type Conflict,
  decideSave,
} from "./conflict-types";
import {
  buildCalendar,
  checkLesson,
  checkSlot,
  checkTimetable,
} from "./conflicts";
import { context, group, h, lesson, slot, TERM } from "./testing/fixtures";
import type { SchedulingContext, SlotCandidate } from "./types";

const types = (conflicts: Conflict[]) => conflicts.map((c) => c.type);

function check(candidate: SlotCandidate, ctx: Partial<SchedulingContext> = {}) {
  return checkSlot(buildCalendar(context(ctx)), candidate);
}

/** A new Monday 09:00–10:30 slot for g2/t2 in r2 unless overridden. */
const candidate = (extra: Partial<SlotCandidate> = {}): SlotCandidate => {
  const base: SlotCandidate = slot("new", {
    groupId: "g2",
    teacherId: "t2",
    roomId: "r2",
  });
  delete base.id;
  return { ...base, ...extra };
};

describe("checkSlot", () => {
  it("reports nothing for a free slot", () => {
    expect(check(candidate(), { slots: [slot("a")] })).toEqual([]);
  });

  it("finds a teacher double-booking with the clashing slot and dates", () => {
    const [conflict] = check(candidate({ teacherId: "t1" }), {
      slots: [slot("a", { startMinute: h(10), endMinute: h(11) })],
    });
    expect(conflict).toMatchObject({
      type: "TEACHER_DOUBLE_BOOKED",
      severity: "blocking",
      key: "TEACHER_DOUBLE_BOOKED:slot:a",
      dates: ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"],
      params: {
        teacher: "Anna",
        otherGroup: "Group g1",
        otherTime: "10:00–11:00",
        dateCount: 4,
        firstDate: "2026-10-12",
      },
      refs: { teacherId: "t1", counterpart: { kind: "slot", id: "a" } },
    });
  });

  it("treats back-to-back slots as free", () => {
    const conflicts = check(
      candidate({ teacherId: "t1", startMinute: h(10, 30), endMinute: h(12) }),
      { slots: [slot("a")] },
    );
    expect(conflicts).toEqual([]);
  });

  it("finds room and group double-bookings", () => {
    const conflicts = check(candidate({ groupId: "g1", roomId: "r1" }), {
      slots: [slot("a")],
    });
    expect(types(conflicts)).toEqual([
      "ROOM_DOUBLE_BOOKED",
      "GROUP_DOUBLE_BOOKED",
    ]);
  });

  it("lets an online room be shared, as an overridable warning", () => {
    const conflicts = check(candidate({ roomId: "online" }), {
      slots: [slot("a", { roomId: "online" })],
    });
    expect(conflicts).toMatchObject([
      { type: "ONLINE_ROOM_SHARED", severity: "overridable" },
    ]);
  });

  it("finds students who are in both groups", () => {
    const conflicts = check(candidate({ groupId: "g3", roomId: null }), {
      slots: [slot("a")],
    });
    expect(conflicts).toMatchObject([
      {
        type: "STUDENT_DOUBLE_BOOKED",
        severity: "overridable",
        params: { studentCount: 1, students: "Student s2" },
        refs: { studentIds: ["s2"], groupId: "g1" },
      },
    ]);
  });

  it("does not compare an edited slot with itself", () => {
    const existing = slot("a");
    expect(check(existing, { slots: [existing] })).toEqual([]);
  });

  it("only compares dates on which both slots are in effect", () => {
    const ctx = {
      slots: [slot("a", { teacherId: "t2", validUntil: "2026-10-25" })],
    };
    expect(check(candidate({ validFrom: "2026-10-26" }), ctx)).toEqual([]);
    expect(check(candidate({ validFrom: "2026-10-19" }), ctx)[0].dates).toEqual(
      ["2026-10-19"],
    );
  });

  it("skips holidays and dates whose lesson was cancelled", () => {
    const conflicts = check(candidate({ teacherId: "t1" }), {
      slots: [slot("a")],
      holidays: [
        {
          id: "hol",
          name: "Break",
          termId: null,
          startDate: "2026-10-19",
          endDate: "2026-10-19",
        },
      ],
      lessons: [
        lesson("l1", {
          timetableSlotId: "a",
          occurrenceDate: "2026-10-26",
          startsAt: new Date("2026-10-26T08:00:00Z"),
          endsAt: new Date("2026-10-26T09:30:00Z"),
          status: "CANCELLED",
        }),
      ],
    });
    expect(conflicts[0].dates).toEqual(["2026-10-12", "2026-11-02"]);
  });

  it("checks against where a lesson actually is, with the substitute teacher", () => {
    const conflicts = check(candidate(), {
      slots: [slot("a")],
      lessons: [
        // a's lesson on 2026-10-19 is taught by t2 instead of t1.
        lesson("l1", {
          timetableSlotId: "a",
          occurrenceDate: "2026-10-19",
          substituteTeacherId: "t2",
          startsAt: new Date("2026-10-19T07:00:00Z"),
          endsAt: new Date("2026-10-19T08:30:00Z"),
        }),
      ],
    });
    expect(conflicts).toMatchObject([
      { type: "TEACHER_DOUBLE_BOOKED", dates: ["2026-10-19"] },
    ]);
  });

  it("finds clashes with ad-hoc lessons", () => {
    const conflicts = check(candidate({ teacherId: "t1" }), {
      lessons: [
        lesson("adhoc", {
          startsAt: new Date("2026-10-19T07:30:00Z"),
          endsAt: new Date("2026-10-19T08:00:00Z"),
        }),
      ],
    });
    expect(conflicts).toMatchObject([
      {
        type: "TEACHER_DOUBLE_BOOKED",
        key: "TEACHER_DOUBLE_BOOKED:lesson:adhoc",
        dates: ["2026-10-19"],
      },
    ]);
  });

  it("compares real instants across the DST change", () => {
    // 2026-10-26 is after the switch to CET; 09:00 local = 08:00Z.
    const conflicts = check(candidate({ teacherId: "t1" }), {
      lessons: [
        lesson("adhoc", {
          startsAt: new Date("2026-10-26T08:00:00Z"),
          endsAt: new Date("2026-10-26T09:00:00Z"),
        }),
        lesson("before", {
          startsAt: new Date("2026-10-26T07:00:00Z"),
          endsAt: new Date("2026-10-26T08:00:00Z"),
        }),
      ],
    });
    expect(conflicts.map((c) => c.key)).toEqual([
      "TEACHER_DOUBLE_BOOKED:lesson:adhoc",
    ]);
  });

  it("checks room capacity against enrolled students; online rooms have none", () => {
    expect(check(candidate({ groupId: "g1" }))).toMatchObject([
      {
        type: "ROOM_CAPACITY_EXCEEDED",
        severity: "overridable",
        params: { room: "Room r2", capacity: 1, studentCount: 2 },
      },
    ]);
    expect(check(candidate({ groupId: "g1", roomId: "online" }))).toEqual([]);
  });

  it("checks 1-on-1 and group sizes", () => {
    const groups = [
      group("g1", ["s1", "s2"], { type: "ONE_ON_ONE", capacity: 1 }),
      group("g2", ["s1", "s2", "s3"], { capacity: 2 }),
    ];
    expect(
      types(check(candidate({ groupId: "g1", roomId: null }), { groups })),
    ).toEqual(["ONE_ON_ONE_STUDENT_COUNT"]);
    expect(
      types(check(candidate({ groupId: "g2", roomId: null }), { groups })),
    ).toEqual(["GROUP_OVER_CAPACITY"]);
  });

  it("blocks archived groups", () => {
    const groups = [group("g2", ["s3"], { archived: true })];
    expect(check(candidate(), { groups })).toMatchObject([
      { type: "GROUP_ARCHIVED", severity: "blocking" },
    ]);
  });

  it("applies weekly unavailability unless a date exception lifts it", () => {
    const availability = [
      {
        id: "weekly",
        teacherId: "t2",
        kind: "WEEKLY_UNAVAILABLE" as const,
        weekday: 1,
        date: null,
        startMinute: h(8),
        endMinute: h(9, 30),
      },
      {
        id: "exception",
        teacherId: "t2",
        kind: "DATE_AVAILABLE" as const,
        weekday: null,
        date: "2026-10-19",
        startMinute: null,
        endMinute: null,
      },
    ];
    expect(check(candidate(), { availability })).toMatchObject([
      {
        type: "TEACHER_UNAVAILABLE_WEEKLY",
        severity: "overridable",
        dates: ["2026-10-12", "2026-10-26", "2026-11-02"],
        params: { teacher: "Ben", allDay: "no", time: "08:00–09:30" },
        refs: { availabilityId: "weekly" },
      },
    ]);
  });

  it("applies one-off unavailability to that date only", () => {
    const availability = [
      {
        id: "conference",
        teacherId: "t2",
        kind: "DATE_UNAVAILABLE" as const,
        weekday: null,
        date: "2026-10-26",
        startMinute: null,
        endMinute: null,
      },
      {
        id: "afternoon",
        teacherId: "t2",
        kind: "DATE_UNAVAILABLE" as const,
        weekday: null,
        date: "2026-11-02",
        startMinute: h(13),
        endMinute: h(17),
      },
    ];
    expect(check(candidate(), { availability })).toMatchObject([
      {
        type: "TEACHER_UNAVAILABLE_ON_DATE",
        key: "TEACHER_UNAVAILABLE_ON_DATE:conference",
        dates: ["2026-10-26"],
        params: { allDay: "yes" },
      },
    ]);
  });

  it("flags days and hours outside the school week", () => {
    expect(
      types(
        check(candidate({ weekday: 7, startMinute: h(20), endMinute: h(22) })),
      ),
    ).toEqual(["OUTSIDE_SCHOOL_DAYS", "OUTSIDE_SCHOOL_HOURS"]);
  });

  it("blocks invalid times and ranges outside the term", () => {
    expect(
      types(check(candidate({ startMinute: h(10), endMinute: h(9) }))),
    ).toEqual(["INVALID_TIME"]);
    expect(types(check(candidate({ weekday: 8 })))).toEqual(["INVALID_TIME"]);
    expect(types(check(candidate({ validFrom: "2026-12-01" })))).toEqual([
      "OUTSIDE_TERM",
    ]);
    expect(
      types(
        check(candidate({ validFrom: "2026-10-20", validUntil: "2026-10-19" })),
      ),
    ).toEqual(["OUTSIDE_TERM"]);
  });

  it("warns when a slot would never produce a lesson", () => {
    const conflicts = check(
      candidate({ validFrom: "2026-10-13", validUntil: "2026-10-18" }),
    );
    expect(types(conflicts)).toEqual(["NO_OCCURRENCES"]);
  });

  it("is deterministic and independent of input order", () => {
    const ctx = context({
      slots: [
        slot("a"),
        slot("b", { groupId: "g3", teacherId: "t3", roomId: "online" }),
      ],
    });
    const reversed: SchedulingContext = {
      ...ctx,
      slots: [...ctx.slots].reverse(),
      groups: [...ctx.groups].reverse(),
    };
    const c = candidate({ teacherId: "t1", groupId: "g3", roomId: "r1" });
    const first = checkSlot(buildCalendar(ctx), c);
    expect(first.length).toBeGreaterThan(2);
    expect(checkSlot(buildCalendar(reversed), c)).toEqual(first);
  });
});

describe("checkLesson", () => {
  const calendar = (ctx: Partial<SchedulingContext> = {}) =>
    buildCalendar(context(ctx));

  it("checks the substitute, not the regular teacher", () => {
    const ctx = {
      lessons: [
        lesson("busy", {
          groupId: "g2",
          teacherId: "t2",
          roomId: "r2",
        }),
      ],
    };
    const moved = {
      ...lesson("x", { teacherId: "t1", substituteTeacherId: "t2" }),
      roomId: null,
      groupId: "g3",
    };
    expect(types(checkLesson(calendar(ctx), moved))).toEqual([
      "TEACHER_DOUBLE_BOOKED",
    ]);
    expect(
      checkLesson(calendar(ctx), { ...moved, substituteTeacherId: null }),
    ).toEqual([]);
  });

  it("does not clash with the slot occurrence it stands for", () => {
    const ctx = { slots: [slot("a", { weekday: 2 })] };
    const generated = lesson("new", {
      timetableSlotId: "a",
      occurrenceDate: "2026-10-13",
    });
    expect(checkLesson(calendar(ctx), generated)).toEqual([]);
  });

  it("flags holidays and dates outside the term", () => {
    const holidays = [
      {
        id: "hol",
        name: "Break",
        termId: TERM.id,
        startDate: "2026-10-13",
        endDate: "2026-10-13",
      },
    ];
    expect(checkLesson(calendar({ holidays }), lesson("x", {}))).toMatchObject([
      {
        type: "LESSON_ON_HOLIDAY",
        severity: "overridable",
        params: { holiday: "Break" },
        dates: ["2026-10-13"],
      },
    ]);
    const late = lesson("x", {
      startsAt: new Date("2026-12-01T08:00:00Z"),
      endsAt: new Date("2026-12-01T09:00:00Z"),
    });
    expect(types(checkLesson(calendar(), late))).toEqual(["OUTSIDE_TERM"]);
  });

  it("blocks a lesson that ends before it starts", () => {
    const broken = lesson("x", {
      endsAt: new Date("2026-10-13T06:00:00Z"),
    });
    expect(types(checkLesson(calendar(), broken))).toEqual(["INVALID_TIME"]);
  });
});

describe("checkTimetable", () => {
  it("reports a clash on both slots", () => {
    const ctx = context({
      slots: [
        slot("a"),
        slot("b", { groupId: "g2", roomId: "online" }),
        slot("c", { groupId: "g2", teacherId: "t2", weekday: 2 }),
      ],
    });
    const result = checkTimetable(buildCalendar(ctx), TERM.id);
    expect([...result.keys()]).toEqual(["a", "b"]);
    expect(result.get("a")![0].key).toBe("TEACHER_DOUBLE_BOOKED:slot:b");
    expect(result.get("b")![0].key).toBe("TEACHER_DOUBLE_BOOKED:slot:a");
  });
});

describe("conflict types", () => {
  it("lists blocking types before overridable ones", () => {
    const severities = CONFLICT_TYPES.map((t) => CONFLICT_SEVERITY[t]);
    expect(severities.indexOf("overridable")).toBe(
      severities.lastIndexOf("blocking") + 1,
    );
  });
});

describe("decideSave", () => {
  const blocking = check(candidate({ teacherId: "t1" }), {
    slots: [slot("a")],
  });
  const overridable = check(candidate({ weekday: 7 }));

  it("never saves over a blocking conflict", () => {
    const keys = blocking.map((c) => c.key);
    expect(decideSave(blocking, keys)).toMatchObject({
      ok: false,
      reason: "BLOCKING_CONFLICTS",
    });
  });

  it("needs every overridable conflict acknowledged", () => {
    expect(decideSave(overridable, [])).toMatchObject({
      ok: false,
      reason: "UNACKNOWLEDGED_CONFLICTS",
      unacknowledged: overridable,
    });
    expect(
      decideSave(
        overridable,
        overridable.map((c) => c.key),
      ),
    ).toEqual({ ok: true, overridden: overridable });
  });

  it("saves a change without conflicts", () => {
    expect(decideSave([], [])).toEqual({ ok: true, overridden: [] });
  });
});
