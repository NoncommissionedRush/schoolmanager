import { describe, expect, it } from "vitest";

import { buildCalendar, checkLesson } from "./conflicts";
import {
  checkReschedule,
  decideAdminReschedule,
  isFreeTime,
  RESCHEDULE_GRID_MINUTES,
  type RescheduleRequest,
  rescheduleOptions,
} from "./reschedule";
import { context, group, h, lesson, TZ } from "./testing/fixtures";
import { isoWeekday, toZonedDateTime, zonedTimeToUtc } from "./time";

const at = (date: string, minute: number) => zonedTimeToUtc(date, minute, TZ);
const NOW = at("2026-10-14", h(12));

// 1-on-1 group "o1" (student s5, teacher t1). The missed lesson was Monday
// 19 Oct 16:00–16:45 in r1; the credit is valid until 30 Oct.
const missed = lesson("missed", {
  groupId: "o1",
  startsAt: at("2026-10-19", h(16)),
  endsAt: at("2026-10-19", h(16, 45)),
  status: "CANCELLED",
});

function calendarWith(lessons = [missed]) {
  const base = context();
  return buildCalendar({
    ...base,
    groups: [
      ...base.groups,
      group("o1", ["s5"], { type: "ONE_ON_ONE", capacity: 1 }),
    ],
    students: [...base.students, { id: "s5", name: "Student s5" }],
    lessons,
  });
}

const request = (
  extra: Partial<RescheduleRequest> = {},
): RescheduleRequest => ({
  mode: "student",
  groupId: "o1",
  teacherId: "t1",
  movingLessonId: null,
  durationMinutes: 45,
  credit: {
    studentId: "s5",
    status: "AVAILABLE",
    expiresAt: at("2026-10-31", 0),
    sourceGroupId: "o1",
    spentOnMoving: false,
  },
  studentId: "s5",
  cutoffMinutes: 1440,
  publishedTermIds: ["term"],
  attending: [],
  ...extra,
});

const slotAt = (date: string, minute: number, minutes = 45, roomId = "r1") => {
  const startsAt = at(date, minute);
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + minutes * 60_000),
    roomId,
  };
};

const codes = (
  extra: Partial<RescheduleRequest>,
  candidate = slotAt("2026-10-22", h(16)),
  calendar = calendarWith(),
) =>
  checkReschedule(calendar, request(extra), candidate, NOW).reasons.map(
    (r) => r.code,
  );

describe("checkReschedule", () => {
  it("accepts a free time with the same length", () => {
    const check = checkReschedule(
      calendarWith(),
      request(),
      slotAt("2026-10-22", h(16)),
      NOW,
    );
    expect(check).toEqual({ reasons: [], conflicts: [], termId: "term" });
    expect(isFreeTime(check)).toBe(true);
  });

  it("needs the student's own available credit from this 1-on-1 group", () => {
    const credit = request().credit!;
    for (const changed of [
      { studentId: "s1" },
      { sourceGroupId: "g1" },
      { status: "USED" as const },
      { expiresAt: NOW },
    ]) {
      expect(codes({ credit: { ...credit, ...changed } })).toContain(
        "CREDIT_UNAVAILABLE",
      );
    }
    expect(codes({ credit: null })).toEqual(["CREDIT_UNAVAILABLE"]);
    // Moving a rescheduled lesson again: its credit is USED on it.
    expect(
      codes({
        credit: { ...credit, status: "USED", spentOnMoving: true },
      }),
    ).toEqual([]);
  });

  it("needs the cutoff as notice and a start before the credit expires", () => {
    // 24 h notice: 15 Oct 12:00 is the first allowed start.
    expect(codes({}, slotAt("2026-10-15", h(11, 45)))).toEqual(["TOO_SOON"]);
    expect(codes({}, slotAt("2026-10-15", h(12)))).toEqual([]);
    expect(codes({}, slotAt("2026-10-31", h(9)))).toEqual([
      "CREDIT_EXPIRES_FIRST",
    ]);
  });

  it("needs a published term and the same length", () => {
    expect(codes({ publishedTermIds: [] })).toEqual(["OUTSIDE_TERM"]);
    expect(codes({}, slotAt("2026-10-22", h(16), 60))).toEqual([
      "DURATION_CHANGED",
    ]);
  });

  it("refuses a clash with the student's other lessons, back-to-back is fine", () => {
    const attending = [
      {
        id: "replacement",
        startsAt: at("2026-10-22", h(16, 30)),
        endsAt: at("2026-10-22", h(17, 30)),
        bookingId: "b1",
      },
    ];
    const check = checkReschedule(
      calendarWith(),
      request({ attending }),
      slotAt("2026-10-22", h(16)),
      NOW,
    );
    expect(check.reasons).toEqual([
      {
        code: "STUDENT_CLASH",
        key: "STUDENT_CLASH:replacement",
        lessonIds: ["replacement"],
      },
    ]);
    expect(codes({ attending }, slotAt("2026-10-22", h(15, 45)))).toEqual([]);
  });

  it("reports every timetable conflict of the new ad-hoc lesson", () => {
    const busy = lesson("busy", {
      groupId: "g2",
      startsAt: at("2026-10-22", h(16)),
      endsAt: at("2026-10-22", h(17)),
    });
    const check = checkReschedule(
      calendarWith([missed, busy]),
      request(),
      slotAt("2026-10-22", h(16)),
      NOW,
    );
    expect(check.conflicts.map((c) => c.type)).toEqual([
      "TEACHER_DOUBLE_BOOKED",
      "ROOM_DOUBLE_BOOKED",
    ]);
    expect(isFreeTime(check)).toBe(false);
  });

  it("never conflicts with the old time of the lesson being moved", () => {
    const moving = lesson("moving", {
      groupId: "o1",
      startsAt: at("2026-10-22", h(16)),
      endsAt: at("2026-10-22", h(16, 45)),
    });
    const calendar = calendarWith([missed, moving]);
    // 15 minutes later overlaps the old time of the same lesson.
    const later = slotAt("2026-10-22", h(16, 15));
    expect(
      checkReschedule(calendar, request(), later, NOW).conflicts.map(
        (c) => c.type,
      ),
    ).toEqual([
      "TEACHER_DOUBLE_BOOKED",
      "ROOM_DOUBLE_BOOKED",
      "GROUP_DOUBLE_BOOKED",
    ]);
    expect(
      checkReschedule(
        calendar,
        request({ movingLessonId: "moving" }),
        later,
        NOW,
      ),
    ).toMatchObject({ reasons: [], conflicts: [] });
  });
});

describe("decideAdminReschedule", () => {
  const admin = (extra: Partial<RescheduleRequest> = {}) =>
    request({ mode: "admin", credit: null, ...extra });

  it("has no notice, expiry or length limits, but no past times", () => {
    const calendar = calendarWith();
    const soon = checkReschedule(
      calendar,
      admin(),
      slotAt("2026-10-14", h(15), 90),
      NOW,
    );
    expect(soon).toMatchObject({ reasons: [], conflicts: [] });
    expect(decideAdminReschedule(soon, [])).toMatchObject({ ok: true });
    const past = checkReschedule(
      calendar,
      admin(),
      slotAt("2026-10-14", h(9)),
      NOW,
    );
    expect(past.reasons.map((r) => r.code)).toEqual(["TOO_SOON"]);
    expect(decideAdminReschedule(past, ["TOO_SOON"])).toMatchObject({
      ok: false,
      reason: "BLOCKING",
    });
  });

  it("refuses blocking conflicts and outside a published term", () => {
    const busy = lesson("busy", {
      groupId: "g2",
      startsAt: at("2026-10-22", h(16)),
      endsAt: at("2026-10-22", h(17)),
    });
    const check = checkReschedule(
      calendarWith([missed, busy]),
      admin(),
      slotAt("2026-10-22", h(16)),
      NOW,
    );
    expect(
      decideAdminReschedule(
        check,
        check.conflicts.map((c) => c.key),
      ),
    ).toMatchObject({ ok: false, reason: "BLOCKING" });
    const outside = checkReschedule(
      calendarWith(),
      admin({ publishedTermIds: [] }),
      slotAt("2026-10-22", h(16)),
      NOW,
    );
    expect(decideAdminReschedule(outside, [])).toMatchObject({
      ok: false,
      reason: "BLOCKING",
    });
  });

  it("saves overridable conflicts and a student clash once acknowledged", () => {
    const attending = [
      {
        id: "other",
        startsAt: at("2026-10-24", h(20)),
        endsAt: at("2026-10-24", h(22)),
      },
    ];
    // Saturday 21:00–21:45 is outside school hours, and clashes.
    const check = checkReschedule(
      calendarWith(),
      admin({ attending }),
      slotAt("2026-10-24", h(21)),
      NOW,
    );
    const keys = [
      ...check.conflicts.map((c) => c.key),
      ...check.reasons.map((r) => r.key),
    ];
    expect(check.conflicts.map((c) => c.type)).toEqual([
      "OUTSIDE_SCHOOL_HOURS",
    ]);
    expect(check.reasons.map((r) => r.code)).toEqual(["STUDENT_CLASH"]);
    expect(decideAdminReschedule(check, [])).toMatchObject({
      ok: false,
      reason: "UNACKNOWLEDGED",
      unacknowledged: keys,
    });
    expect(decideAdminReschedule(check, keys)).toMatchObject({
      ok: true,
      overriddenReasons: [expect.objectContaining({ code: "STUDENT_CLASH" })],
    });
  });

  describe("spending the student's credit (CARM-47)", () => {
    const fresh = request().credit!;

    it("has no notice limit, and a time before the expiry passes", () => {
      const check = checkReschedule(
        calendarWith(),
        admin({ credit: fresh }),
        slotAt("2026-10-14", h(15)),
        NOW,
      );
      expect(check).toMatchObject({ reasons: [], conflicts: [] });
    });

    it("asks to acknowledge a time on or after the expiry", () => {
      // The credit expires at the start of 31 Oct; Monday 2 Nov is after.
      const check = checkReschedule(
        calendarWith(),
        admin({ credit: fresh }),
        slotAt("2026-11-02", h(16)),
        NOW,
      );
      expect(check.reasons.map((r) => r.key)).toEqual(["CREDIT_EXPIRES_FIRST"]);
      expect(decideAdminReschedule(check, [])).toMatchObject({
        ok: false,
        reason: "UNACKNOWLEDGED",
        unacknowledged: ["CREDIT_EXPIRES_FIRST"],
      });
      expect(
        decideAdminReschedule(check, ["CREDIT_EXPIRES_FIRST"]),
      ).toMatchObject({
        ok: true,
        overriddenReasons: [
          expect.objectContaining({ code: "CREDIT_EXPIRES_FIRST" }),
        ],
      });
    });

    it("refuses a credit that isn't usable", () => {
      for (const credit of [
        { ...fresh, status: "USED" as const },
        { ...fresh, studentId: "s1" },
        { ...fresh, sourceGroupId: "g1" },
        // Expired by now, even if not marked yet.
        { ...fresh, expiresAt: NOW },
      ]) {
        const check = checkReschedule(
          calendarWith(),
          admin({ credit }),
          slotAt("2026-10-22", h(16)),
          NOW,
        );
        expect(check.reasons[0]?.code).toBe("CREDIT_UNAVAILABLE");
        expect(
          decideAdminReschedule(
            check,
            check.reasons.map((r) => r.key),
          ),
        ).toMatchObject({ ok: false, reason: "BLOCKING" });
      }
    });

    it("never checks the expiry of a credit moving with its lesson", () => {
      const check = checkReschedule(
        calendarWith(),
        admin({
          credit: { ...fresh, status: "USED", spentOnMoving: true },
          movingLessonId: "moving",
        }),
        slotAt("2026-11-02", h(16)),
        NOW,
      );
      expect(check.reasons).toEqual([]);
    });
  });
});

describe("rescheduleOptions", () => {
  const usual = { weekday: 1, startMinute: h(16) };

  it("offers the usual weekday and time first, then nearest date and time", () => {
    const options = rescheduleOptions(
      calendarWith(),
      request(),
      usual,
      ["r1"],
      NOW,
    );
    expect(options).toHaveLength(20);
    const local = options.map((o) => toZonedDateTime(o.startsAt, TZ));
    // Mondays 19 and 26 Oct at 16:00 first (the usual time).
    expect(options.slice(0, 2).every((o) => o.usual)).toBe(true);
    expect(local.slice(0, 2)).toEqual([
      { date: "2026-10-19", minute: h(16) },
      { date: "2026-10-26", minute: h(16) },
    ]);
    // Then from the first allowed start (15 Oct 12:00) on the 15-minute grid.
    expect(local[2]).toEqual({ date: "2026-10-15", minute: h(12) });
    expect(local[3]).toEqual({ date: "2026-10-15", minute: h(12, 15) });
    for (const l of local) expect(l.minute % RESCHEDULE_GRID_MINUTES).toBe(0);
  });

  it("only offers times that pass every check, and is deterministic", () => {
    const busy = lesson("busy", {
      groupId: "g2",
      startsAt: at("2026-10-15", h(12)),
      endsAt: at("2026-10-15", h(13)),
    });
    const calendar = calendarWith([missed, busy]);
    const options = rescheduleOptions(calendar, request(), usual, ["r1"], NOW);
    for (const o of options) {
      expect(
        checkLesson(calendar, {
          termId: "term",
          timetableSlotId: null,
          occurrenceDate: null,
          groupId: "o1",
          teacherId: "t1",
          substituteTeacherId: null,
          roomId: o.roomId,
          startsAt: o.startsAt,
          endsAt: o.endsAt,
        }),
      ).toEqual([]);
      expect(o.startsAt.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(
        1440 * 60_000,
      );
    }
    // The teacher is busy 12:00–13:00: next free start is 13:00.
    const firstOther = options.find((o) => !o.usual)!;
    expect(toZonedDateTime(firstOther.startsAt, TZ)).toEqual({
      date: "2026-10-15",
      minute: h(13),
    });
    expect(rescheduleOptions(calendar, request(), usual, ["r1"], NOW)).toEqual(
      options,
    );
  });

  it("falls back to the next room when the preferred one is taken", () => {
    const roomBusy = lesson("room-busy", {
      groupId: "g2",
      teacherId: "t2",
      startsAt: at("2026-10-19", h(16)),
      endsAt: at("2026-10-19", h(17)),
    });
    const [first] = rescheduleOptions(
      calendarWith([missed, roomBusy]),
      request(),
      usual,
      ["r1", "r2"],
      NOW,
      1,
    );
    expect(first).toMatchObject({ roomId: "r2", usual: true });
  });

  it("stays on teaching days, inside school hours, before expiry, also over the DST change", () => {
    const options = rescheduleOptions(
      calendarWith(),
      request(),
      usual,
      ["r1"],
      NOW,
      1_000,
    );
    const local = options.map((o) => toZonedDateTime(o.startsAt, TZ));
    expect(local.some((l) => isoWeekday(l.date) === 7)).toBe(false);
    expect(local.every((l) => l.minute >= h(7) && l.minute + 45 <= h(21))).toBe(
      true,
    );
    expect(local.at(-1)!.date <= "2026-10-30").toBe(true);
    // Monday 26 Oct (after DST ends) still starts at 16:00 local.
    expect(local).toContainEqual({ date: "2026-10-26", minute: h(16) });
  });

  it("offers nothing without a credit", () => {
    expect(
      rescheduleOptions(
        calendarWith(),
        request({ credit: null }),
        usual,
        ["r1"],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("rescheduleOptions for a lesson being moved", () => {
  it("never offers the lesson's own current time", () => {
    const moving = lesson("moving", {
      groupId: "o1",
      startsAt: at("2026-10-19", h(16)),
      endsAt: at("2026-10-19", h(16, 45)),
    });
    const options = rescheduleOptions(
      calendarWith([moving]),
      request({ movingLessonId: "moving", movingStartsAt: moving.startsAt }),
      { weekday: 1, startMinute: h(16) },
      ["r1"],
      NOW,
    );
    expect(options[0]).toMatchObject({
      startsAt: at("2026-10-26", h(16)),
      usual: true,
    });
  });
});
