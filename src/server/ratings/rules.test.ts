import { describe, expect, it } from "vitest";

import {
  attendedByTermAndTeacher,
  attendedLessons,
  canRate,
  type CanRateInput,
  normalizeComment,
  RATING_MIN_LESSONS,
  ratingCardState,
  ratingClosesAt,
  ratingOpensAt,
  type RatingLesson,
  type StudentAttendance,
  summarizeRatings,
} from "./rules";

const TZ = "Europe/Bratislava";
const TERM = { id: "term", startDate: "2026-09-01", endDate: "2026-12-20" };

let seq = 0;
function lesson(overrides: Partial<RatingLesson> = {}): RatingLesson {
  seq += 1;
  return {
    id: `lesson-${String(seq).padStart(3, "0")}`,
    termId: "term",
    groupId: "g1",
    teacherId: "t1",
    substituteTeacherId: null,
    startsAt: new Date("2026-10-05T15:00:00Z"),
    endsAt: new Date("2026-10-05T16:00:00Z"),
    status: "SCHEDULED",
    ...overrides,
  };
}

const student = (
  overrides: Partial<StudentAttendance> = {},
): StudentAttendance => ({
  memberships: [
    { groupId: "g1", joinedAt: new Date("2026-09-01T00:00:00Z"), leftAt: null },
  ],
  absentLessonIds: new Set(),
  replacementLessonIds: new Set(),
  ...overrides,
});

const NOW = new Date("2026-11-20T12:00:00Z");

describe("rating window", () => {
  it("opens at the start of the local half-term day (even length)", () => {
    // 110 days → half = 55 → 2026-10-26, local midnight (CET, UTC+1).
    expect(ratingOpensAt(TERM, TZ).toISOString()).toBe(
      "2026-10-25T23:00:00.000Z",
    );
  });

  it("rounds half-term down for odd lengths", () => {
    // 2026-09-01 … 2026-09-04: 3 days → half = 1 → 09-02, CEST (UTC+2).
    expect(
      ratingOpensAt(
        { id: "t", startDate: "2026-09-01", endDate: "2026-09-04" },
        TZ,
      ).toISOString(),
    ).toBe("2026-09-01T22:00:00.000Z");
  });

  it("closes at the start of the local day 14 days after the term ends", () => {
    expect(ratingClosesAt(TERM, TZ).toISOString()).toBe(
      "2027-01-02T23:00:00.000Z",
    );
  });
});

describe("attendedLessons", () => {
  it("counts ended lessons of the student's group", () => {
    const l = lesson();
    expect(attendedLessons(student(), [l], NOW)).toEqual([l]);
  });

  it("skips cancelled lessons", () => {
    expect(
      attendedLessons(student(), [lesson({ status: "CANCELLED" })], NOW),
    ).toEqual([]);
  });

  it("skips lessons that started but haven't ended", () => {
    const now = new Date("2026-10-05T15:30:00Z");
    expect(attendedLessons(student(), [lesson()], now)).toEqual([]);
    expect(
      attendedLessons(student(), [lesson()], new Date("2026-10-05T16:00:00Z")),
    ).toHaveLength(1);
  });

  it("skips lessons with an absence report", () => {
    const l = lesson();
    expect(
      attendedLessons(student({ absentLessonIds: new Set([l.id]) }), [l], NOW),
    ).toEqual([]);
  });

  it("counts a replacement into another group", () => {
    const l = lesson({ groupId: "g2" });
    expect(attendedLessons(student(), [l], NOW)).toEqual([]);
    expect(
      attendedLessons(
        student({ replacementLessonIds: new Set([l.id]) }),
        [l],
        NOW,
      ),
    ).toEqual([l]);
  });

  it("respects membership dates", () => {
    const s = student({
      memberships: [
        {
          groupId: "g1",
          joinedAt: new Date("2026-10-01T00:00:00Z"),
          leftAt: new Date("2026-10-10T00:00:00Z"),
        },
      ],
    });
    const before = lesson({
      startsAt: new Date("2026-09-28T15:00:00Z"),
      endsAt: new Date("2026-09-28T16:00:00Z"),
    });
    const during = lesson();
    const after = lesson({
      startsAt: new Date("2026-10-12T15:00:00Z"),
      endsAt: new Date("2026-10-12T16:00:00Z"),
    });
    expect(attendedLessons(s, [after, during, before], NOW)).toEqual([during]);
  });

  it("groups by term and effective teacher (a substitute counts)", () => {
    const a = lesson();
    const b = lesson({ substituteTeacherId: "t2" });
    const map = attendedByTermAndTeacher(student(), [a, b], NOW);
    expect(map.get("term")?.get("t1")).toEqual([a]);
    expect(map.get("term")?.get("t2")).toEqual([b]);
  });

  it("is independent of input order", () => {
    const ls = [lesson(), lesson(), lesson()];
    expect(attendedLessons(student(), [...ls].reverse(), NOW)).toEqual(
      attendedLessons(student(), ls, NOW),
    );
  });
});

describe("canRate", () => {
  const input = (overrides: Partial<CanRateInput> = {}): CanRateInput => ({
    isStudent: true,
    teacherKnown: true,
    attended: RATING_MIN_LESSONS,
    term: TERM,
    timeZone: TZ,
    now: NOW,
    ...overrides,
  });

  it("allows a student with enough lessons inside the window", () => {
    expect(canRate(input())).toMatchObject({ ok: true, reasons: [] });
  });

  it.each([
    ["NOT_A_STUDENT", { isStudent: false }],
    ["TEACHER_UNKNOWN", { teacherKnown: false }],
    ["TOO_FEW_LESSONS", { attended: RATING_MIN_LESSONS - 1 }],
    ["NOT_OPEN_YET", { now: new Date("2026-10-25T22:59:59Z") }],
    ["WINDOW_CLOSED", { now: new Date("2027-01-02T23:00:00Z") }],
  ] as const)("%s", (reason, overrides) => {
    expect(canRate(input(overrides))).toMatchObject({
      ok: false,
      reasons: [reason],
    });
  });

  it("is open exactly at opensAt and until just before closesAt", () => {
    expect(canRate(input({ now: new Date("2026-10-25T23:00:00Z") })).ok).toBe(
      true,
    );
    expect(canRate(input({ now: new Date("2027-01-02T22:59:59Z") })).ok).toBe(
      true,
    );
  });

  it("returns every failing reason", () => {
    expect(
      canRate(
        input({
          isStudent: false,
          attended: 0,
          now: new Date("2026-09-10T00:00:00Z"),
        }),
      ).reasons,
    ).toEqual(["NOT_A_STUDENT", "TOO_FEW_LESSONS", "NOT_OPEN_YET"]);
  });
});

describe("ratingCardState", () => {
  const result = (reasons: string[]) =>
    ({
      ok: reasons.length === 0,
      reasons,
      opensAt: new Date(),
      closesAt: new Date(),
    }) as Parameters<typeof ratingCardState>[0];

  it.each([
    [[], false, "open"],
    [[], true, "rated"],
    [["NOT_OPEN_YET"], false, "opensLater"],
    [["NOT_OPEN_YET", "TOO_FEW_LESSONS"], false, null],
    [["TOO_FEW_LESSONS"], false, null],
    [["WINDOW_CLOSED"], true, "closed"],
    [["WINDOW_CLOSED"], false, null],
  ] as const)("%j, rated=%s → %s", (reasons, rated, state) => {
    expect(ratingCardState(result([...reasons]), rated)).toBe(state);
  });
});

describe("summarizeRatings", () => {
  const row = (score: number, hidden = false, day = 1) => ({
    score,
    hiddenAt: hidden ? new Date("2026-11-30T00:00:00Z") : null,
    createdAt: new Date(`2026-11-0${day}T00:00:00Z`),
    updatedAt: new Date(`2026-11-0${day}T00:00:00Z`),
  });

  it("hides the average below 3 visible ratings", () => {
    expect(summarizeRatings([row(5), row(1)])).toMatchObject({
      count: 2,
      average: null,
    });
  });

  it("averages to one decimal and counts the distribution", () => {
    expect(summarizeRatings([row(5), row(4), row(4, false, 3)])).toEqual({
      count: 3,
      average: 4.3,
      distribution: [0, 0, 0, 2, 1],
      lastRatedAt: new Date("2026-11-03T00:00:00Z"),
      hidden: 0,
    });
  });

  it("leaves hidden ratings out", () => {
    expect(
      summarizeRatings([row(5), row(5), row(5), row(1, true, 9)]),
    ).toMatchObject({
      count: 3,
      average: 5,
      distribution: [0, 0, 0, 0, 3],
      hidden: 1,
    });
  });

  it("handles no ratings", () => {
    expect(summarizeRatings([])).toEqual({
      count: 0,
      average: null,
      distribution: [0, 0, 0, 0, 0],
      lastRatedAt: null,
      hidden: 0,
    });
  });
});

describe("normalizeComment", () => {
  it.each([
    [null, null],
    ["", null],
    ["   ", null],
    ["  Great  ", "Great"],
  ])("%j → %j", (input, output) => {
    expect(normalizeComment(input)).toBe(output);
  });
});
