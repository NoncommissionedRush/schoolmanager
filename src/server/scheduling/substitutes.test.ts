import { describe, expect, it } from "vitest";

import { buildCalendar } from "./conflicts";
import {
  checkSubstitute,
  checkSubstituteRemoval,
  clampSubstitutionRange,
  isoWeekOf,
  lessonPhase,
  lessonsNeedingCover,
  substituteKey,
  substituteLessonReasons,
  type SubstituteTeacher,
  suggestSubstitutes,
  teachingMinutes,
} from "./substitutes";
import { context, group, lesson, TZ } from "./testing/fixtures";
import { zonedTimeToUtc } from "./time";
import type { AvailabilityRule, LessonInfo, SchedulingContext } from "./types";

// Tue 13 Oct 2026; Bratislava is UTC+2 until 25 Oct.
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return zonedTimeToUtc(date, h * 60 + m, TZ);
};
const lessonAt = (
  id: string,
  date: string,
  start: string,
  end: string,
  extra: Partial<LessonInfo> = {},
): LessonInfo =>
  lesson(id, { startsAt: at(date, start), endsAt: at(date, end), ...extra });

// The lesson to cover: group g1 (level B1), Anna (t1), Tue 09:00–10:30.
const L = lessonAt("L", "2026-10-13", "09:00", "10:30", { roomId: "r1" });
const NOW = at("2026-10-12", "12:00");

const teachers: SubstituteTeacher[] = [
  { id: "t1", name: "Anna", archived: false, maxMinutesPerWeek: null },
  { id: "t2", name: "Ben", archived: false, maxMinutesPerWeek: null },
  { id: "t3", name: "Cleo", archived: false, maxMinutesPerWeek: null },
  { id: "t4", name: "Dora", archived: false, maxMinutesPerWeek: null },
];
const teacher = (id: string, extra: Partial<SubstituteTeacher> = {}) => ({
  ...teachers.find((t) => t.id === id)!,
  ...extra,
});

function ctx(extra: Partial<SchedulingContext> = {}): SchedulingContext {
  const base = context();
  return {
    ...base,
    groups: [
      group("g1", ["s1", "s2"], { levelId: "B1" }),
      group("g2", ["s3"], { levelId: "B1" }),
      group("g3", ["s4"], { levelId: "A2" }),
    ],
    teachers: [...base.teachers, { id: "t4", name: "Dora" }],
    levels: [
      { id: "B1", name: "B1" },
      { id: "A2", name: "A2" },
    ],
    teacherLevels: [
      { teacherId: "t1", levelId: "B1" },
      { teacherId: "t2", levelId: "B1" },
      { teacherId: "t3", levelId: "B1" },
      { teacherId: "t4", levelId: "B1" },
    ],
    lessons: [L],
    ...extra,
  };
}

const codes = (reasons: { code: string }[]) => reasons.map((r) => r.code);

describe("substituteLessonReasons (§3.2)", () => {
  it("refuses cancelled, unpublished and long-ended lessons", () => {
    expect(substituteLessonReasons(L, { published: true, now: NOW })).toEqual(
      [],
    );
    expect(
      substituteLessonReasons(
        { ...L, status: "CANCELLED" },
        { published: false, now: NOW },
      ),
    ).toEqual(["LESSON_CANCELLED", "TERM_NOT_PUBLISHED"]);
    const sevenDays = new Date(L.endsAt.getTime() + 7 * 86_400_000);
    expect(
      substituteLessonReasons(L, { published: true, now: sevenDays }),
    ).toEqual([]);
    expect(
      substituteLessonReasons(L, {
        published: true,
        now: new Date(sevenDays.getTime() + 1),
      }),
    ).toEqual(["TOO_LATE_TO_RECORD"]);
  });

  it("phases: upcoming, started, ended", () => {
    expect(lessonPhase(L, NOW)).toBe("upcoming");
    expect(lessonPhase(L, L.startsAt)).toBe("started");
    expect(lessonPhase(L, L.endsAt)).toBe("ended");
  });
});

describe("checkSubstitute (§3.3)", () => {
  it("an eligible teacher has no reason", () => {
    expect(checkSubstitute(buildCalendar(ctx()), L, teacher("t2"))).toEqual([]);
  });

  it("refuses the regular teacher, the current substitute and archived teachers", () => {
    const calendar = buildCalendar(ctx());
    expect(codes(checkSubstitute(calendar, L, teacher("t1")))).toEqual([
      "IS_REGULAR_TEACHER",
    ]);
    expect(
      codes(
        checkSubstitute(
          calendar,
          { ...L, substituteTeacherId: "t2" },
          teacher("t2"),
        ),
      ),
    ).toEqual(["IS_CURRENT"]);
    const archived = checkSubstitute(
      calendar,
      L,
      teacher("t3", { archived: true }),
    );
    expect(archived).toMatchObject([{ code: "ARCHIVED", severity: "refused" }]);
  });

  it("BUSY when teaching another lesson then, with the other group", () => {
    const other = lessonAt("O", "2026-10-13", "10:00", "11:00", {
      groupId: "g2",
      teacherId: "t2",
      roomId: "r2",
    });
    const reasons = checkSubstitute(
      buildCalendar(ctx({ lessons: [L, other] })),
      L,
      teacher("t2"),
    );
    expect(reasons).toMatchObject([
      {
        code: "BUSY",
        severity: "blocking",
        params: { otherGroup: "Group g2", otherTime: "10:00–11:00" },
      },
    ]);
  });

  it("a substitute elsewhere is busy too; a covered regular teacher is free", () => {
    const covered = lessonAt("C", "2026-10-13", "09:00", "10:30", {
      groupId: "g2",
      teacherId: "t2",
      substituteTeacherId: "t3",
      roomId: "r2",
    });
    const calendar = buildCalendar(ctx({ lessons: [L, covered] }));
    expect(codes(checkSubstitute(calendar, L, teacher("t3")))).toEqual([
      "BUSY",
    ]);
    expect(checkSubstitute(calendar, L, teacher("t2"))).toEqual([]);
  });

  const rule = (extra: Partial<AvailabilityRule>): AvailabilityRule => ({
    id: "a1",
    teacherId: "t3",
    kind: "WEEKLY_UNAVAILABLE",
    weekday: 2,
    date: null,
    startMinute: 8 * 60,
    endMinute: 12 * 60,
    ...extra,
  });

  it("weekly and one-off unavailability are overridable", () => {
    const weekly = checkSubstitute(
      buildCalendar(ctx({ availability: [rule({})] })),
      L,
      teacher("t3"),
    );
    expect(weekly).toMatchObject([
      {
        code: "UNAVAILABLE_WEEKLY",
        severity: "overridable",
        key: substituteKey("t3", "UNAVAILABLE_WEEKLY"),
        params: { weekday: 2, time: "08:00–12:00", allDay: "no" },
      },
    ]);
    const oneOff = checkSubstitute(
      buildCalendar(
        ctx({
          availability: [
            rule({
              kind: "DATE_UNAVAILABLE",
              weekday: null,
              date: "2026-10-13",
              startMinute: null,
              endMinute: null,
            }),
          ],
        }),
      ),
      L,
      teacher("t3"),
    );
    expect(oneOff).toMatchObject([
      {
        code: "UNAVAILABLE_ON_DATE",
        params: { date: "2026-10-13", allDay: "yes" },
      },
    ]);
  });

  it("LEVEL_NOT_TAUGHT also for a teacher with no level rows", () => {
    const calendar = buildCalendar(
      ctx({
        teacherLevels: [
          { teacherId: "t1", levelId: "B1" },
          { teacherId: "t2", levelId: "A2" },
        ],
      }),
    );
    expect(checkSubstitute(calendar, L, teacher("t2"))).toMatchObject([
      { code: "LEVEL_NOT_TAUGHT", params: { level: "B1", levels: "A2" } },
    ]);
    expect(checkSubstitute(calendar, L, teacher("t3"))).toMatchObject([
      { code: "LEVEL_NOT_TAUGHT", params: { level: "B1", levels: "" } },
    ]);
  });

  it("max hours: exactly at the limit is fine, one minute over is not", () => {
    // Ben already teaches 180 minutes that week (Wed), L is 90.
    const wed = lessonAt("W", "2026-10-14", "09:00", "12:00", {
      groupId: "g2",
      teacherId: "t2",
      roomId: "r2",
    });
    const calendar = buildCalendar(ctx({ lessons: [L, wed] }));
    expect(
      checkSubstitute(calendar, L, teacher("t2", { maxMinutesPerWeek: 270 })),
    ).toEqual([]);
    expect(
      checkSubstitute(calendar, L, teacher("t2", { maxMinutesPerWeek: 269 })),
    ).toMatchObject([
      { code: "OVER_MAX_HOURS", params: { current: 180, with: 270, max: 269 } },
    ]);
  });

  it("ignores the lesson's own conflicts (room, holiday, students)", () => {
    const clash = lessonAt("R", "2026-10-13", "09:00", "10:30", {
      groupId: "g3",
      teacherId: "t4",
      roomId: "r1", // same room: the lesson's problem, not the substitute's
    });
    const calendar = buildCalendar(
      ctx({
        lessons: [L, clash],
        holidays: [
          {
            id: "h",
            name: "Day off",
            termId: null,
            startDate: "2026-10-13",
            endDate: "2026-10-13",
          },
        ],
      }),
    );
    expect(checkSubstitute(calendar, L, teacher("t2"))).toEqual([]);
  });

  it("returns every reason that applies", () => {
    const other = lessonAt("O", "2026-10-13", "09:30", "10:00", {
      groupId: "g2",
      teacherId: "t3",
      roomId: "r2",
    });
    const calendar = buildCalendar(
      ctx({
        lessons: [L, other],
        availability: [rule({})],
        teacherLevels: [{ teacherId: "t1", levelId: "B1" }],
      }),
    );
    expect(
      codes(
        checkSubstitute(calendar, L, teacher("t3", { maxMinutesPerWeek: 60 })),
      ),
    ).toEqual([
      "BUSY",
      "UNAVAILABLE_WEEKLY",
      "LEVEL_NOT_TAUGHT",
      "OVER_MAX_HOURS",
    ]);
  });
});

describe("teachingMinutes (§3.4)", () => {
  it("counts the effective teacher's non-cancelled lessons starting in range", () => {
    const week = isoWeekOf(L.startsAt, TZ);
    const lessons = [
      L,
      lessonAt("A", "2026-10-15", "09:00", "10:00", { teacherId: "t1" }),
      // Covered by Ben: Anna doesn't teach it, Ben does.
      lessonAt("B", "2026-10-16", "09:00", "10:00", {
        teacherId: "t1",
        substituteTeacherId: "t2",
      }),
      lessonAt("C", "2026-10-17", "09:00", "10:00", {
        teacherId: "t1",
        status: "CANCELLED",
      }),
      lessonAt("N", "2026-10-19", "09:00", "10:00", { teacherId: "t1" }), // next week
    ];
    expect(teachingMinutes(lessons, "t1", week)).toBe(150);
    expect(teachingMinutes(lessons, "t1", week, "L")).toBe(60);
    expect(teachingMinutes(lessons, "t2", week)).toBe(60);
  });

  it("the ISO week spans the DST change in local time", () => {
    // 25 Oct 2026: clocks go back. Mon 19 Oct 00:00 (UTC+2) to Mon 26 Oct 00:00 (UTC+1).
    const week = isoWeekOf(at("2026-10-25", "23:30"), TZ);
    expect(week.from.toISOString()).toBe("2026-10-18T22:00:00.000Z");
    expect(week.to.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    const sundayLate = lessonAt("S", "2026-10-25", "23:00", "23:45");
    const mondayEarly = lessonAt("M", "2026-10-26", "00:00", "00:30");
    expect(teachingMinutes([sundayLate, mondayEarly], "t1", week)).toBe(45);
  });
});

describe("suggestSubstitutes (§3.7)", () => {
  const history = { groupLessons: [] as LessonInfo[] };

  it("leaves out the regular teacher and archived teachers; bands and ranks", () => {
    const busy = lessonAt("O", "2026-10-13", "09:00", "10:00", {
      groupId: "g2",
      teacherId: "t4",
      roomId: "r2",
    });
    const calendar = buildCalendar(
      ctx({
        lessons: [L, busy],
        teacherLevels: [{ teacherId: "t2", levelId: "B1" }],
      }),
    );
    const out = suggestSubstitutes(
      calendar,
      L,
      [
        ...teachers,
        { id: "t5", name: "Eve", archived: true, maxMinutesPerWeek: null },
      ],
      history,
      NOW,
    );
    expect(out.map((s) => [s.teacherId, s.band, s.rank])).toEqual([
      ["t2", "SUGGESTED", 1],
      ["t3", "WITH_WARNING", null],
      ["t4", "NOT_POSSIBLE", null],
    ]);
  });

  it("ranks by knowsGroup, sameDay, week minutes, term substitutions, name", () => {
    const base = ctx();
    // Ben taught g1 last week (ended), Cleo teaches 10:30–11:30 the same day
    // (gap 0), Dora has fewer minutes this week than anyone.
    const benPast = lessonAt("P", "2026-10-06", "09:00", "10:30", {
      teacherId: "t2",
    });
    const cleoSameDay = lessonAt("S", "2026-10-13", "10:30", "11:30", {
      groupId: "g2",
      teacherId: "t3",
      roomId: "r2",
    });
    const calendar = buildCalendar({ ...base, lessons: [L, cleoSameDay] });
    const out = suggestSubstitutes(
      calendar,
      L,
      teachers,
      { groupLessons: [benPast] },
      NOW,
    );
    expect(out.map((s) => s.teacherId)).toEqual(["t2", "t3", "t4"]);
    expect(out[0]).toMatchObject({
      rank: 1,
      hints: ["KNOWS_GROUP", "FEWEST_HOURS"],
      facts: {
        knowsGroup: true,
        sameDay: false,
        weekMinutesBefore: 0,
        weekMinutesAfter: 90,
      },
    });
    expect(out[1]).toMatchObject({
      rank: 2,
      hints: ["SAME_DAY"],
      facts: { sameDay: true, weekMinutesAfter: 150 },
    });
    expect(out[2]).toMatchObject({ rank: 3, hints: ["FEWEST_HOURS"] });
  });

  it("fewer week minutes, then fewer term substitutions, then the name", () => {
    const covered = lessonAt("X", "2026-10-20", "09:00", "10:00", {
      groupId: "g2",
      teacherId: "t2",
      substituteTeacherId: "t3",
      roomId: "r2",
    });
    const nextWeek = lessonAt("Y", "2026-10-21", "09:00", "10:00", {
      groupId: "g3",
      teacherId: "t4",
      roomId: "r2",
    });
    const calendar = buildCalendar(ctx({ lessons: [L, covered, nextWeek] }));
    const out = suggestSubstitutes(calendar, L, teachers, history, NOW);
    // Same minutes this week (0): Cleo has one substitution, Dora and Ben none.
    expect(out.map((s) => s.name)).toEqual(["Ben", "Dora", "Cleo"]);
    expect(out.map((s) => s.facts.termSubstitutions)).toEqual([0, 0, 1]);
    // At most two hints; FEWEST_HOURS ties are all included.
    expect(out.every((s) => s.hints.includes("FEWEST_HOURS"))).toBe(true);
  });

  it("lists the current substitute first, checked as if the lesson had none", () => {
    const calendar = buildCalendar(
      ctx({ lessons: [{ ...L, substituteTeacherId: "t3" }] }),
    );
    const out = suggestSubstitutes(
      calendar,
      { ...L, substituteTeacherId: "t3" },
      teachers,
      history,
      NOW,
    );
    expect(out[0]).toMatchObject({
      teacherId: "t3",
      current: true,
      reasons: [],
      rank: null,
    });
    expect(out.slice(1).map((s) => s.rank)).toEqual([1, 2]);
  });

  it("doesn't depend on the order of the teachers", () => {
    const calendar = buildCalendar(ctx());
    const a = suggestSubstitutes(calendar, L, teachers, history, NOW);
    const b = suggestSubstitutes(
      calendar,
      L,
      [...teachers].reverse(),
      history,
      NOW,
    );
    expect(b).toEqual(a);
  });
});

describe("checkSubstituteRemoval (§3.5)", () => {
  it("refuses when the regular teacher teaches another lesson then", () => {
    const covered = { ...L, substituteTeacherId: "t2" };
    const other = lessonAt("O", "2026-10-13", "10:00", "11:00", {
      groupId: "g2",
      teacherId: "t1",
      roomId: "r2",
    });
    const check = checkSubstituteRemoval(
      buildCalendar(ctx({ lessons: [covered, other] })),
      covered,
    );
    expect(check).toMatchObject({
      refused: true,
      refusal: "REGULAR_TEACHER_BUSY",
      otherGroup: "Group g2",
      reasons: [],
    });
  });

  it("refuses when the regular teacher is archived, before anything else", () => {
    const covered = { ...L, substituteTeacherId: "t2" };
    const other = lessonAt("O", "2026-10-13", "10:00", "11:00", {
      groupId: "g2",
      teacherId: "t1",
      roomId: "r2",
    });
    const calendar = buildCalendar(ctx({ lessons: [covered, other] }));
    expect(
      checkSubstituteRemoval(calendar, covered, { regularArchived: true }),
    ).toEqual({
      refused: true,
      refusal: "REGULAR_TEACHER_ARCHIVED",
      otherGroup: null,
      reasons: [],
    });
  });

  it("other teacher conflicts of the regular teacher are overridable", () => {
    const covered = { ...L, substituteTeacherId: "t2" };
    const check = checkSubstituteRemoval(
      buildCalendar(
        ctx({
          lessons: [covered],
          availability: [
            {
              id: "a",
              teacherId: "t1",
              kind: "DATE_UNAVAILABLE",
              weekday: null,
              date: "2026-10-13",
              startMinute: null,
              endMinute: null,
            },
          ],
        }),
      ),
      covered,
    );
    expect(check.refused).toBe(false);
    expect(check.refusal).toBeNull();
    expect(check.reasons).toMatchObject([
      {
        code: "UNAVAILABLE_ON_DATE",
        severity: "overridable",
        key: substituteKey("t1", "UNAVAILABLE_ON_DATE"),
      },
    ]);
  });
});

describe("lessonsNeedingCover (§3.7)", () => {
  const from = NOW;
  const to = at("2026-12-01", "00:00");

  it("regular teacher away on the date or archived; weekly unavailability left out", () => {
    const wed = lessonAt("W", "2026-10-14", "09:00", "10:30");
    const thu = lessonAt("T", "2026-10-15", "09:00", "10:30", {
      teacherId: "t2",
    });
    const calendar = buildCalendar(
      ctx({
        lessons: [L, wed, thu],
        availability: [
          {
            id: "a",
            teacherId: "t1",
            kind: "DATE_UNAVAILABLE",
            weekday: null,
            date: "2026-10-13",
            startMinute: null,
            endMinute: null,
          },
          {
            id: "b",
            teacherId: "t1",
            kind: "WEEKLY_UNAVAILABLE",
            weekday: 3,
            date: null,
            startMinute: null,
            endMinute: null,
          },
        ],
      }),
    );
    expect(lessonsNeedingCover(calendar, from, to, new Set(["t2"]))).toEqual([
      {
        lessonId: "L",
        who: "REGULAR",
        reasons: ["UNAVAILABLE_ON_DATE"],
        otherGroup: null,
      },
      {
        lessonId: "T",
        who: "REGULAR",
        reasons: ["ARCHIVED"],
        otherGroup: null,
      },
    ]);
  });

  it("a covered lesson whose substitute is away or double-booked comes back", () => {
    const covered = { ...L, substituteTeacherId: "t2" };
    const clash = lessonAt("O", "2026-10-13", "10:00", "11:00", {
      groupId: "g2",
      teacherId: "t2",
      roomId: "r2",
    });
    const calendar = buildCalendar(ctx({ lessons: [covered, clash] }));
    expect(lessonsNeedingCover(calendar, from, to, new Set())).toEqual([
      {
        lessonId: "L",
        who: "SUBSTITUTE",
        reasons: ["DOUBLE_BOOKED"],
        otherGroup: "Group g2",
      },
      {
        lessonId: "O",
        who: "REGULAR",
        reasons: ["DOUBLE_BOOKED"],
        otherGroup: "Group g1",
      },
    ]);
  });

  it("a range starting later includes a lesson at its very first instant", () => {
    const midnight = lessonAt("M", "2026-10-14", "00:00", "01:00");
    const calendar = buildCalendar(ctx({ lessons: [midnight] }));
    expect(
      lessonsNeedingCover(
        calendar,
        midnight.startsAt,
        to,
        new Set(["t1"]),
        NOW,
      ).map((n) => n.lessonId),
    ).toEqual(["M"]);
  });

  it("leaves out started and cancelled lessons", () => {
    const calendar = buildCalendar(
      ctx({
        lessons: [
          L,
          lessonAt("X", "2026-10-14", "09:00", "10:00", {
            status: "CANCELLED",
          }),
        ],
      }),
    );
    expect(
      lessonsNeedingCover(calendar, L.startsAt, to, new Set(["t1"])).map(
        (n) => n.lessonId,
      ),
    ).toEqual([]);
  });
});

describe("clampSubstitutionRange", () => {
  it("keeps a range up to the cap", () => {
    expect(clampSubstitutionRange("2026-10-19", "2026-12-14")).toEqual({
      from: "2026-10-19",
      to: "2026-12-14",
    });
    // 92 days: 19 Oct … 18 Jan.
    expect(clampSubstitutionRange("2026-10-19", "2027-01-18")).toEqual({
      from: "2026-10-19",
      to: "2027-01-18",
    });
  });

  it("caps a longer range at SUBSTITUTION_RANGE_MAX_DAYS", () => {
    expect(clampSubstitutionRange("2026-10-19", "2036-10-19")).toEqual({
      from: "2026-10-19",
      to: "2027-01-18",
    });
  });

  it("swaps a reversed range first", () => {
    expect(clampSubstitutionRange("2026-12-14", "2026-10-19")).toEqual({
      from: "2026-10-19",
      to: "2026-12-14",
    });
  });
});
