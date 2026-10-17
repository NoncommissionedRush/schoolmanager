import { describe, expect, it } from "vitest";

import { addDays, zonedTimeToUtc } from "@/server/scheduling";

import {
  attendanceRate,
  attendanceReport,
  type AttendanceInput,
  checkRange,
  checkRowLimit,
  defaultTerm,
  expectedFor,
  formatRate,
  isMakeupLesson,
  minutesToHours,
  periodInstants,
  reachesPastNow,
  REPORT_MAX_ROWS,
  ReportError,
  type ReportLesson,
  resolvePeriod,
  roundHalfUpDiv,
  sortAttendance,
  teacherHoursLessons,
  teacherHoursReport,
  type TeacherHoursInput,
} from "./rules";

const TZ = "Europe/Bratislava";
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return zonedTimeToUtc(date, h * 60 + m, TZ);
};
const PERIOD = { from: "2026-09-01", to: "2026-12-20" };
const RANGE = periodInstants(PERIOD, TZ);
const NOW = at("2026-12-21", "12:00");

let seq = 0;
function lesson(
  date: string,
  extra: Partial<ReportLesson> & { time?: string; minutes?: number } = {},
): ReportLesson {
  const { time = "17:00", minutes = 60, ...rest } = extra;
  const startsAt = at(date, time);
  return {
    id: `L${String(++seq).padStart(3, "0")}`,
    termId: "term",
    groupId: "g1",
    teacherId: "t1",
    substituteTeacherId: null,
    roomId: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + minutes * 60_000),
    status: "SCHEDULED",
    cancelReason: null,
    rescheduledFromId: null,
    ...rest,
  };
}

const JOINED = new Date("2026-08-01T00:00:00Z");
const member = (studentId: string, groupId: string, extra = {}) => ({
  studentId,
  groupId,
  joinedAt: JOINED,
  leftAt: null as Date | null,
  ...extra,
});

const groups = new Map(
  (
    [
      ["g1", "B1 Evening", "GROUP", "B1"],
      ["g2", "A2 Morning", "GROUP", "A2"],
      ["o1", "Sara 1-on-1", "ONE_ON_ONE", "B2"],
    ] as const
  ).map(([id, name, type, levelCode]) => [
    id,
    { id, name, type, levelCode, archived: false },
  ]),
);
const students = new Map(
  [
    ["s1", "Sara"],
    ["s2", "Pavol"],
    ["s3", "Rita"],
  ].map(([id, name]) => [id, { id, name, archived: false }]),
);
const teachers = new Map(
  [
    ["t1", "Tomas"],
    ["t2", "Ana"],
    ["t3", "Eva"],
  ].map(([id, name]) => [id, { id, name, archived: false }]),
);

function attendance(
  partial: Partial<AttendanceInput> & { lessons: ReportLesson[] },
) {
  return attendanceReport({
    chain: new Map(partial.lessons.map((l) => [l.id, l])),
    memberships: [member("s1", "g1"), member("s2", "g1")],
    absences: [],
    replacements: [],
    groups,
    students,
    range: RANGE,
    now: NOW,
    filters: {},
    ...partial,
  });
}
const rowOf = (
  report: ReturnType<typeof attendance>,
  studentId: string,
  groupId: string,
) =>
  report.rows.find((r) => r.studentId === studentId && r.groupId === groupId);

describe("arithmetic", () => {
  it("roundHalfUpDiv rounds exact halves up", () => {
    expect(roundHalfUpDiv(1, 2)).toBe(1);
    expect(roundHalfUpDiv(3, 2)).toBe(2);
    expect(roundHalfUpDiv(4, 10)).toBe(0);
    expect(roundHalfUpDiv(5, 10)).toBe(1);
    expect(roundHalfUpDiv(0, 7)).toBe(0);
  });

  it("minutesToHours gives two decimals, half up, in integers", () => {
    expect(minutesToHours(750)).toBe("12.50");
    expect(minutesToHours(0)).toBe("0.00");
    expect(minutesToHours(1)).toBe("0.02");
    expect(minutesToHours(10)).toBe("0.17");
    expect(minutesToHours(45)).toBe("0.75");
    expect(minutesToHours(50)).toBe("0.83");
    expect(minutesToHours(24_765)).toBe("412.75");
  });

  it("attendance rate is tenths of a percent, rounded half up", () => {
    expect(attendanceRate(7, 8)).toBe(875);
    expect(formatRate(attendanceRate(7, 8))).toBe("87.5");
    // 1/16 = 6.25 % → 6.3 %
    expect(attendanceRate(1, 16)).toBe(63);
    expect(formatRate(63)).toBe("6.3");
    expect(formatRate(attendanceRate(1, 1))).toBe("100.0");
    expect(formatRate(attendanceRate(0, 3))).toBe("0.0");
    expect(attendanceRate(0, 0)).toBeNull();
    expect(formatRate(null)).toBe("");
  });
});

describe("period (§2)", () => {
  const terms = [
    { id: "a", name: "Spring", startDate: "2026-02-01", endDate: "2026-06-30" },
    { id: "b", name: "Autumn", startDate: "2026-09-01", endDate: "2026-12-20" },
    {
      id: "c",
      name: "Spring 27",
      startDate: "2027-02-01",
      endDate: "2027-06-30",
    },
  ];

  it("defaults to the running term, else the latest started, else the first", () => {
    expect(defaultTerm(terms, "2026-10-01")?.id).toBe("b");
    expect(defaultTerm(terms, "2027-01-10")?.id).toBe("b");
    expect(defaultTerm(terms, "2025-01-01")?.id).toBe("a");
    expect(defaultTerm([], "2026-10-01")).toBeNull();
  });

  it("uses custom dates over the term, a term id, or the default term", () => {
    expect(resolvePeriod({ termId: "a" }, terms, "2026-10-01")).toEqual({
      termId: "a",
      from: "2026-02-01",
      to: "2026-06-30",
    });
    expect(resolvePeriod({}, terms, "2026-10-01").termId).toBe("b");
    expect(
      resolvePeriod(
        { termId: "a", from: "2026-10-01", to: "2026-10-31" },
        terms,
        "2026-10-01",
      ),
    ).toEqual({ termId: null, from: "2026-10-01", to: "2026-10-31" });
  });

  it("refuses unknown terms, no terms and bad periods", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as ReportError).code;
      }
      return "ok";
    };
    expect(
      code(() => resolvePeriod({ termId: "x" }, terms, "2026-10-01")),
    ).toBe("NOT_FOUND");
    expect(code(() => resolvePeriod({}, [], "2026-10-01"))).toBe("NO_TERM");
    expect(
      code(() => resolvePeriod({ from: "2026-10-01" }, terms, "2026-10-01")),
    ).toBe("INVALID_RANGE");
    expect(
      code(() =>
        resolvePeriod({ from: "2026-10-02", to: "2026-10-01" }, [], "x"),
      ),
    ).toBe("INVALID_RANGE");
    expect(
      code(() =>
        resolvePeriod({ from: "2026-02-30", to: "2026-03-01" }, [], "x"),
      ),
    ).toBe("INVALID_RANGE");
    expect(
      code(() =>
        resolvePeriod({ from: "01.10.2026", to: "2026-10-01" }, [], "x"),
      ),
    ).toBe("INVALID_RANGE");
  });

  it("allows 366 days counted inclusively, not 367", () => {
    expect(() =>
      checkRange("2026-01-01", addDays("2026-01-01", 365)),
    ).not.toThrow();
    expect(() => checkRange("2026-01-01", addDays("2026-01-01", 366))).toThrow(
      new ReportError("RANGE_TOO_LONG"),
    );
    expect(() => checkRange("2026-01-01", "2026-01-01")).not.toThrow();
  });

  it("covers local days in the school's time zone, DST days included", () => {
    // 25 Oct 2026: clocks go back, the day has 25 hours.
    const autumn = periodInstants({ from: "2026-10-25", to: "2026-10-25" }, TZ);
    expect(autumn.to.getTime() - autumn.from.getTime()).toBe(25 * 3_600_000);
    expect(autumn.from.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    // 29 Mar 2026: clocks go forward, 23 hours.
    const spring = periodInstants({ from: "2026-03-29", to: "2026-03-29" }, TZ);
    expect(spring.to.getTime() - spring.from.getTime()).toBe(23 * 3_600_000);

    const range = autumn;
    const now = at("2026-10-27", "00:00");
    const inside = lesson("2026-10-25", {
      time: "23:00",
      minutes: 30,
      teacherId: "t1",
    });
    const before = lesson("2026-10-24", { time: "23:30", minutes: 30 });
    const after = lesson("2026-10-26", { time: "00:00", minutes: 30 });
    const report = teacherHoursReport({
      lessons: [inside, before, after],
      teachers,
      range,
      now,
      filters: {},
    });
    expect(report.rows.map((r) => r.lessons)).toEqual([1]);
  });

  it("says when the period reaches past now", () => {
    expect(reachesPastNow(RANGE, at("2026-12-20", "12:00"))).toBe(true);
    expect(reachesPastNow(RANGE, at("2026-12-21", "00:00"))).toBe(false);
  });

  it("refuses more than 50,000 CSV rows with the count", () => {
    expect(() => checkRowLimit(REPORT_MAX_ROWS)).not.toThrow();
    try {
      checkRowLimit(REPORT_MAX_ROWS + 1);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ReportError);
      expect((error as ReportError).code).toBe("TOO_MANY_ROWS");
      expect((error as ReportError).count).toBe(50_001);
    }
  });
});

describe("isMakeupLesson (§3.2)", () => {
  const chain = (...lessons: ReportLesson[]) =>
    new Map(lessons.map((l) => [l.id, l]));
  const cancelled = (reason: string, extra: Partial<ReportLesson> = {}) =>
    lesson("2026-10-05", {
      groupId: "o1",
      status: "CANCELLED",
      cancelReason: reason,
      ...extra,
    });

  it("is false for regular and ad-hoc lessons", () => {
    const l = lesson("2026-10-05");
    expect(isMakeupLesson(l, chain(l))).toBe(false);
  });

  it("is true for a student reschedule and Book with credit", () => {
    const p = cancelled("STUDENT_CANCELLED");
    const m = lesson("2026-10-07", { groupId: "o1", rescheduledFromId: p.id });
    expect(isMakeupLesson(m, chain(p, m))).toBe(true);
  });

  it("is true for a re-reschedule: the makeup was cancelled by the student again", () => {
    const p = cancelled("STUDENT_CANCELLED");
    const m1 = cancelled("STUDENT_CANCELLED", { rescheduledFromId: p.id });
    const m2 = lesson("2026-10-09", {
      groupId: "o1",
      rescheduledFromId: m1.id,
    });
    expect(isMakeupLesson(m2, chain(p, m1, m2))).toBe(true);
  });

  it("is false for an admin move of a regular lesson", () => {
    const p = cancelled("RESCHEDULED");
    const n = lesson("2026-10-07", { groupId: "o1", rescheduledFromId: p.id });
    expect(isMakeupLesson(n, chain(p, n))).toBe(false);
  });

  it("stays true for an admin move of a makeup", () => {
    const p = cancelled("STUDENT_CANCELLED");
    const m = cancelled("RESCHEDULED", { rescheduledFromId: p.id });
    const n = lesson("2026-10-09", { groupId: "o1", rescheduledFromId: m.id });
    expect(isMakeupLesson(n, chain(p, m, n))).toBe(true);
  });

  it("passes the role on through slot-split successors", () => {
    const regular = cancelled("TIMETABLE_CHANGED");
    const successor = lesson("2026-10-07", { rescheduledFromId: regular.id });
    expect(isMakeupLesson(successor, chain(regular, successor))).toBe(false);
    const p = cancelled("STUDENT_CANCELLED");
    const m = cancelled("TIMETABLE_CHANGED", { rescheduledFromId: p.id });
    const s = lesson("2026-10-09", { rescheduledFromId: m.id });
    expect(isMakeupLesson(s, chain(p, m, s))).toBe(true);
  });

  it("stops after 50 steps with CHAIN_TOO_LONG", () => {
    const a = cancelled("RESCHEDULED");
    const b = cancelled("RESCHEDULED", { rescheduledFromId: a.id });
    a.rescheduledFromId = b.id;
    expect(() => isMakeupLesson(a, chain(a, b))).toThrow(
      new ReportError("CHAIN_TOO_LONG"),
    );
  });
});

describe("expectedFor (§3.2)", () => {
  const m = [member("s1", "g1")];
  it("needs membership, a non-cancelled lesson (or the student's own cancellation) and no makeup", () => {
    expect(expectedFor(m, lesson("2026-10-05"), false, false)).toBe(true);
    expect(
      expectedFor(m, lesson("2026-10-05", { groupId: "g2" }), false, false),
    ).toBe(false);
    expect(expectedFor(m, lesson("2026-10-05"), false, true)).toBe(false);
    const holiday = lesson("2026-10-05", {
      status: "CANCELLED",
      cancelReason: "HOLIDAY",
    });
    expect(expectedFor(m, holiday, true, false)).toBe(false);
    const own = lesson("2026-10-05", {
      status: "CANCELLED",
      cancelReason: "STUDENT_CANCELLED",
    });
    expect(expectedFor(m, own, true, false)).toBe(true);
    expect(expectedFor(m, own, false, false)).toBe(false);
  });
});

describe("attendance report (§3)", () => {
  it("group lesson: attended unless the student reported an absence", () => {
    const [l1, l2, l3] = ["2026-10-05", "2026-10-12", "2026-10-19"].map((d) =>
      lesson(d),
    );
    const report = attendance({
      lessons: [l1, l2, l3],
      absences: [
        { lessonId: l1.id, studentId: "s1", hasCredit: true },
        { lessonId: l2.id, studentId: "s1", hasCredit: false },
      ],
    });
    expect(rowOf(report, "s1", "g1")).toMatchObject({
      expected: 3,
      absent: 2,
      absentWithCredit: 1,
      absentLate: 1,
      attended: 1,
      attendanceRate: 333,
      makeupsAttended: 0,
    });
    expect(rowOf(report, "s2", "g1")).toMatchObject({
      expected: 3,
      absent: 0,
      attended: 3,
      attendanceRate: 1000,
    });
  });

  it("a replacement seat counts as a makeup of the original group, not as expected", () => {
    const missed = lesson("2026-10-05");
    const target = lesson("2026-10-07", { groupId: "g2", teacherId: "t2" });
    const report = attendance({
      lessons: [missed, target],
      memberships: [member("s1", "g1")],
      absences: [{ lessonId: missed.id, studentId: "s1", hasCredit: true }],
      replacements: [
        {
          studentId: "s1",
          targetLessonId: target.id,
          originalGroupId: "g1",
          status: "AUTO_APPROVED",
        },
      ],
    });
    expect(report.rows).toHaveLength(1);
    expect(rowOf(report, "s1", "g1")).toMatchObject({
      expected: 1,
      absent: 1,
      makeupsAttended: 1,
    });
  });

  it("ignores cancelled bookings and makeups that haven't ended or were cancelled", () => {
    const missed = lesson("2026-10-05");
    const future = lesson("2026-12-22", { groupId: "g2" });
    const cancelledTarget = lesson("2026-10-07", {
      groupId: "g2",
      status: "CANCELLED",
      cancelReason: "HOLIDAY",
    });
    const ran = lesson("2026-10-09", { groupId: "g2" });
    const booking = (targetLessonId: string, status = "APPROVED") => ({
      studentId: "s1",
      targetLessonId,
      originalGroupId: "g1",
      status,
    });
    const report = attendance({
      lessons: [missed, future, cancelledTarget, ran],
      memberships: [member("s1", "g1")],
      replacements: [
        booking(future.id),
        booking(cancelledTarget.id),
        booking(ran.id, "CANCELLED"),
        booking(ran.id, "REJECTED"),
      ],
    });
    expect(rowOf(report, "s1", "g1")?.makeupsAttended).toBe(0);
  });

  it("1-on-1s: own cancellations are expected and absent, makeups count as makeups", () => {
    const cancelledInTime = lesson("2026-10-05", {
      groupId: "o1",
      status: "CANCELLED",
      cancelReason: "STUDENT_CANCELLED",
    });
    const lateCancel = lesson("2026-10-12", { groupId: "o1" });
    const makeup = lesson("2026-10-14", {
      groupId: "o1",
      rescheduledFromId: cancelledInTime.id,
    });
    const regular = lesson("2026-10-19", { groupId: "o1" });
    const report = attendance({
      lessons: [cancelledInTime, lateCancel, makeup, regular],
      memberships: [member("s1", "o1")],
      absences: [
        { lessonId: cancelledInTime.id, studentId: "s1", hasCredit: true },
        { lessonId: lateCancel.id, studentId: "s1", hasCredit: false },
      ],
    });
    expect(rowOf(report, "s1", "o1")).toMatchObject({
      expected: 3,
      absent: 2,
      absentWithCredit: 1,
      absentLate: 1,
      attended: 1,
      makeupsAttended: 1,
    });
  });

  it("a cancelled makeup isn't attended; an admin-moved 1-on-1 is expected at its new time", () => {
    const cancelledInTime = lesson("2026-10-05", {
      groupId: "o1",
      status: "CANCELLED",
      cancelReason: "STUDENT_CANCELLED",
    });
    const makeup = lesson("2026-10-14", {
      groupId: "o1",
      status: "CANCELLED",
      cancelReason: "SCHOOL_CANCELLED",
      rescheduledFromId: cancelledInTime.id,
    });
    const moved = lesson("2026-10-19", {
      groupId: "o1",
      status: "CANCELLED",
      cancelReason: "RESCHEDULED",
    });
    const newTime = lesson("2026-10-20", {
      groupId: "o1",
      rescheduledFromId: moved.id,
    });
    const report = attendance({
      lessons: [cancelledInTime, makeup, moved, newTime],
      memberships: [member("s1", "o1")],
      absences: [
        { lessonId: cancelledInTime.id, studentId: "s1", hasCredit: true },
      ],
    });
    expect(rowOf(report, "s1", "o1")).toMatchObject({
      expected: 2,
      absent: 1,
      attended: 1,
      makeupsAttended: 0,
    });
  });

  it("lessons cancelled by the school are not expected; COMPLETED counts like SCHEDULED", () => {
    const report = attendance({
      lessons: [
        lesson("2026-10-05", { status: "CANCELLED", cancelReason: "HOLIDAY" }),
        lesson("2026-10-06", {
          status: "CANCELLED",
          cancelReason: "TIMETABLE_CHANGED",
        }),
        lesson("2026-10-07", { status: "COMPLETED" }),
      ],
      memberships: [member("s1", "g1")],
    });
    expect(rowOf(report, "s1", "g1")?.expected).toBe(1);
  });

  it("counts only lessons while the student is a member", () => {
    const lessons = [
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ].map((d) => lesson(d));
    const report = attendance({
      lessons,
      memberships: [
        member("s1", "g1", { joinedAt: at("2026-10-10", "00:00") }),
        member("s2", "g1", { leftAt: at("2026-10-19", "17:00") }),
      ],
    });
    expect(rowOf(report, "s1", "g1")?.expected).toBe(3);
    // Left exactly when the third lesson starts: not a member then.
    expect(rowOf(report, "s2", "g1")?.expected).toBe(2);
  });

  it("counts ended lessons in the period only", () => {
    const report = attendance({
      lessons: [
        lesson("2026-08-31"),
        lesson("2026-09-01", { time: "00:00" }),
        lesson("2026-12-21", { time: "11:00" }), // ends exactly at NOW
        lesson("2026-12-21", { time: "11:30" }), // still running
      ],
      memberships: [member("s1", "g1")],
      range: periodInstants({ from: "2026-09-01", to: "2026-12-21" }, TZ),
    });
    expect(rowOf(report, "s1", "g1")?.expected).toBe(2);
  });

  it("a substitute changes nothing, but the teacher filter uses the effective teacher", () => {
    const own = lesson("2026-10-05");
    const covered = lesson("2026-10-12", { substituteTeacherId: "t2" });
    const input = {
      lessons: [own, covered],
      memberships: [member("s1", "g1")],
    };
    expect(rowOf(attendance(input), "s1", "g1")?.expected).toBe(2);
    expect(
      rowOf(attendance({ ...input, filters: { teacherId: "t1" } }), "s1", "g1")
        ?.expected,
    ).toBe(1);
    expect(
      rowOf(attendance({ ...input, filters: { teacherId: "t2" } }), "s1", "g1")
        ?.expected,
    ).toBe(1);
  });

  it("filters by group and student, and by the makeup's own teacher", () => {
    const missed = lesson("2026-10-05");
    const target = lesson("2026-10-07", { groupId: "g2", teacherId: "t3" });
    const base = {
      lessons: [missed, target],
      memberships: [member("s1", "g1"), member("s2", "g1"), member("s3", "g2")],
      absences: [{ lessonId: missed.id, studentId: "s1", hasCredit: true }],
      replacements: [
        {
          studentId: "s1",
          targetLessonId: target.id,
          originalGroupId: "g1",
          status: "OVERRIDDEN",
        },
      ],
    };
    const keys = (r: ReturnType<typeof attendance>) =>
      r.rows.map((x) => `${x.studentId}@${x.groupId}`);
    expect(keys(attendance({ ...base, filters: { groupId: "g2" } }))).toEqual([
      "s3@g2",
    ]);
    expect(keys(attendance({ ...base, filters: { studentId: "s1" } }))).toEqual(
      ["s1@g1"],
    );
    // t3 taught the makeup (and g2's lesson), not s1's missed lesson.
    const byT3 = attendance({ ...base, filters: { teacherId: "t3" } });
    expect(rowOf(byT3, "s1", "g1")).toMatchObject({
      expected: 0,
      makeupsAttended: 1,
      attendanceRate: null,
    });
    expect(rowOf(byT3, "s3", "g2")?.expected).toBe(1);
    const byT1 = attendance({ ...base, filters: { teacherId: "t1" } });
    expect(rowOf(byT1, "s1", "g1")).toMatchObject({
      expected: 1,
      makeupsAttended: 0,
    });
  });

  it("totals sum the columns; the rate comes from the sums", () => {
    const lessons = ["2026-10-05", "2026-10-12", "2026-10-19"].map((d) =>
      lesson(d),
    );
    const report = attendance({
      lessons: [...lessons, lesson("2026-10-06", { groupId: "g2" })],
      memberships: [member("s1", "g1"), member("s2", "g2")],
      absences: [{ lessonId: lessons[0].id, studentId: "s1", hasCredit: true }],
    });
    // Rows: 2/3 and 1/1. Average of rates would be 83.3 %; the sum is 3/4.
    expect(report.totals).toEqual({
      expected: 4,
      absent: 1,
      absentWithCredit: 1,
      absentLate: 0,
      attended: 3,
      attendanceRate: 750,
      makeupsAttended: 0,
    });
  });

  it("sorts by group, student, ids; output doesn't depend on input order", () => {
    const lessons = [
      lesson("2026-10-05"),
      lesson("2026-10-06", { groupId: "g2" }),
      lesson("2026-10-07", { groupId: "o1" }),
    ];
    const memberships = [
      member("s1", "g1"),
      member("s2", "g1"),
      member("s3", "g2"),
      member("s1", "o1"),
    ];
    const a = attendance({ lessons, memberships });
    const b = attendance({
      lessons: [...lessons].reverse(),
      memberships: [...memberships].reverse(),
    });
    expect(b).toEqual(a);
    expect(a.rows.map((r) => `${r.groupName}/${r.studentName}`)).toEqual([
      "A2 Morning/Rita",
      "B1 Evening/Pavol",
      "B1 Evening/Sara",
      "Sara 1-on-1/Sara",
    ]);
  });

  it("sorts by a column; ties and missing rates fall back to the default order", () => {
    const l = [lesson("2026-10-05"), lesson("2026-10-12")];
    const report = attendance({
      lessons: [...l, lesson("2026-10-06", { groupId: "g2" })],
      memberships: [member("s1", "g1"), member("s2", "g1"), member("s3", "g2")],
      absences: [{ lessonId: l[0].id, studentId: "s1", hasCredit: false }],
    });
    const withNoRate = [
      ...report.rows,
      {
        ...report.rows[0],
        studentId: "s9",
        studentName: "Zoe",
        expected: 0,
        attended: 0,
        absent: 0,
        attendanceRate: null,
      },
    ];
    const names = (rows: { studentName: string }[]) =>
      rows.map((r) => r.studentName);
    expect(names(sortAttendance(withNoRate, "rate", "asc"))).toEqual([
      "Sara",
      "Rita",
      "Pavol",
      "Zoe",
    ]);
    expect(names(sortAttendance(withNoRate, "rate", "desc"))).toEqual([
      "Rita",
      "Pavol",
      "Sara",
      "Zoe",
    ]);
    expect(names(sortAttendance(report.rows, "student", "asc"))).toEqual([
      "Pavol",
      "Rita",
      "Sara",
    ]);
    expect(names(sortAttendance(report.rows, "group", "desc"))).toEqual([
      "Sara",
      "Pavol",
      "Rita",
    ]);
  });
});

describe("teacher hours (§4)", () => {
  const input = (
    lessons: ReportLesson[],
    extra: Partial<TeacherHoursInput> = {},
  ): TeacherHoursInput => ({
    lessons,
    teachers,
    range: RANGE,
    now: NOW,
    filters: {},
    ...extra,
  });

  const lessons = () => [
    lesson("2026-10-05", { minutes: 90 }),
    lesson("2026-10-06", { minutes: 60, groupId: "g2" }),
    lesson("2026-10-07", { minutes: 45, substituteTeacherId: "t2" }),
    lesson("2026-10-08", {
      minutes: 60,
      status: "CANCELLED",
      cancelReason: "HOLIDAY",
    }),
    lesson("2026-10-09", { minutes: 60, teacherId: "t2" }),
    lesson("2026-12-22", { minutes: 60 }), // not ended yet
    // Eva's only lesson was covered by Tomas.
    lesson("2026-10-10", {
      minutes: 30,
      teacherId: "t3",
      substituteTeacherId: "t1",
    }),
  ];

  it("counts each column; a covered lesson counts for the substitute only", () => {
    const report = teacherHoursReport(input(lessons()));
    expect(report.rows).toEqual([
      {
        teacherId: "t2",
        name: "Ana",
        archived: false,
        lessons: 2,
        regularMinutes: 60,
        substituteMinutes: 45,
        totalMinutes: 105,
        hours: "1.75",
        coveredByOthersMinutes: 0,
      },
      {
        teacherId: "t1",
        name: "Tomas",
        archived: false,
        lessons: 3,
        regularMinutes: 150,
        substituteMinutes: 30,
        totalMinutes: 180,
        hours: "3.00",
        coveredByOthersMinutes: 45,
      },
    ]);
    // Eva taught nothing herself: not listed.
    expect(report.rows.map((r) => r.teacherId)).not.toContain("t3");
    expect(report.totals).toEqual({
      lessons: 5,
      regularMinutes: 210,
      substituteMinutes: 75,
      totalMinutes: 285,
      // Column sums: Eva's 30 covered minutes aren't in a listed row.
      coveredByOthersMinutes: 45,
    });
    for (const row of report.rows) {
      expect(row.regularMinutes + row.substituteMinutes).toBe(row.totalMinutes);
    }
  });

  it("filters by teacher and group", () => {
    const byTeacher = teacherHoursReport(
      input(lessons(), { filters: { teacherId: "t2" } }),
    );
    expect(byTeacher.rows.map((r) => r.teacherId)).toEqual(["t2"]);
    const byGroup = teacherHoursReport(
      input(lessons(), { filters: { groupId: "g2" } }),
    );
    expect(byGroup.rows).toMatchObject([
      { teacherId: "t1", lessons: 1, totalMinutes: 60 },
    ]);
  });

  it("lists archived teachers with their hours", () => {
    const archived = new Map(teachers);
    archived.set("t2", { id: "t2", name: "Ana", archived: true });
    const report = teacherHoursReport(input(lessons(), { teachers: archived }));
    expect(report.rows.find((r) => r.teacherId === "t2")).toMatchObject({
      archived: true,
      totalMinutes: 105,
    });
  });

  it("lesson details: one row per lesson taught, in local time, sorted by start", () => {
    const all = lessons();
    all[0].roomId = "r1";
    const rows = teacherHoursLessons({
      ...input([...all].reverse(), { filters: { teacherId: "t1" } }),
      groups,
      rooms: new Map([["r1", "Room 1"]]),
      timeZone: TZ,
    });
    expect(
      rows.map((r) => [r.date, r.start, r.end, r.minutes, r.role]),
    ).toEqual([
      ["2026-10-05", "17:00", "18:30", 90, "REGULAR"],
      ["2026-10-06", "17:00", "18:00", 60, "REGULAR"],
      ["2026-10-10", "17:00", "17:30", 30, "SUBSTITUTE"],
    ]);
    expect(rows[0]).toMatchObject({
      teacherName: "Tomas",
      regularTeacherName: "Tomas",
      groupName: "B1 Evening",
      levelCode: "B1",
      roomName: "Room 1",
    });
    expect(rows[2]).toMatchObject({
      teacherName: "Tomas",
      regularTeacherName: "Eva",
      roomName: null,
    });
    const every = teacherHoursLessons({
      ...input(all),
      groups,
      rooms: new Map(),
      timeZone: TZ,
    });
    expect(every).toHaveLength(5);
  });
});
