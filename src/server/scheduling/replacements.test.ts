import { describe, expect, it } from "vitest";

import {
  buildRoster,
  checkAbsence,
  checkAbsenceDelete,
  checkReplacement,
  creditExpiry,
  creditState,
  cutoffAt,
  daysLeft,
  decideOverride,
  earnsCredit,
  planAbsence,
  planBookingCancel,
  releaseCredit,
  type ReplacementCheckInput,
  reviewReplacement,
  seatsTaken,
  studentClashes,
  validUntilOf,
} from "./replacements";
import { zonedTimeToUtc } from "./time";

const TZ = "Europe/Bratislava";
const HOUR = 3_600_000;
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return zonedTimeToUtc(date, h * 60 + m, TZ);
};

describe("earnsCredit", () => {
  const start = at("2026-10-20", "17:00");

  it("earns a credit exactly at the cutoff, not a millisecond after", () => {
    const cutoff = cutoffAt(start, 1440);
    expect(cutoff).toEqual(at("2026-10-19", "17:00"));
    expect(earnsCredit(start, cutoff, 1440)).toBe(true);
    expect(earnsCredit(start, new Date(cutoff.getTime() + 1), 1440)).toBe(
      false,
    );
  });

  it("with cutoff 0, earns a credit until the lesson starts", () => {
    expect(earnsCredit(start, new Date(start.getTime() - 1), 0)).toBe(true);
    expect(earnsCredit(start, start, 0)).toBe(true);
  });
});

describe("creditExpiry", () => {
  it("is valid until the missed lesson's date plus the validity days", () => {
    const { validUntil, expiresAt } = creditExpiry(
      at("2026-10-20", "17:00"),
      30,
      TZ,
    );
    expect(validUntil).toBe("2026-11-19");
    // Start of the next local day (CET, UTC+1 after the DST change).
    expect(expiresAt.toISOString()).toBe("2026-11-19T23:00:00.000Z");
    expect(validUntilOf(expiresAt, TZ)).toBe("2026-11-19");
  });

  it("uses the local date, not the UTC one, for a late-evening lesson", () => {
    // 00:30 local on 21 Oct is still 20 Oct in UTC.
    const { validUntil } = creditExpiry(at("2026-10-21", "00:30"), 1, TZ);
    expect(validUntil).toBe("2026-10-22");
  });

  it("handles the end of summer time inside the window", () => {
    const { expiresAt } = creditExpiry(at("2026-10-20", "09:00"), 7, TZ);
    // 27 Oct is after the switch on 25 Oct: midnight CET = 23:00 UTC.
    expect(expiresAt.toISOString()).toBe("2026-10-27T23:00:00.000Z");
  });
});

describe("creditState", () => {
  const expiresAt = at("2026-11-20", "00:00");

  it("treats an AVAILABLE credit at or past its expiry as EXPIRED", () => {
    const credit = { status: "AVAILABLE" as const, expiresAt };
    expect(creditState(credit, new Date(expiresAt.getTime() - 1))).toBe(
      "AVAILABLE",
    );
    expect(creditState(credit, expiresAt)).toBe("EXPIRED");
  });

  it("keeps USED and EXPIRED as they are", () => {
    const later = new Date(expiresAt.getTime() + HOUR);
    expect(creditState({ status: "USED", expiresAt }, later)).toBe("USED");
    expect(creditState({ status: "EXPIRED", expiresAt }, later)).toBe(
      "EXPIRED",
    );
  });
});

describe("daysLeft", () => {
  it("counts local days until the last valid day", () => {
    const expiresAt = at("2026-10-23", "00:00"); // valid until 22 Oct
    expect(daysLeft(expiresAt, at("2026-10-22", "23:59"), TZ)).toBe(0);
    expect(daysLeft(expiresAt, at("2026-10-15", "08:00"), TZ)).toBe(7);
  });
});

describe("checkAbsence", () => {
  const now = at("2026-10-14", "12:00");
  const base = {
    lesson: {
      startsAt: at("2026-10-20", "17:00"),
      status: "SCHEDULED" as const,
      published: true,
    },
    isMember: true,
    hasActiveReplacement: false,
    alreadyReported: false,
  };

  it("allows a member's upcoming scheduled lesson", () => {
    expect(checkAbsence(base, now)).toEqual([]);
  });

  it("returns every failing reason in a fixed order", () => {
    expect(
      checkAbsence(
        {
          lesson: { startsAt: now, status: "CANCELLED", published: false },
          isMember: false,
          hasActiveReplacement: false,
          alreadyReported: true,
        },
        now,
      ),
    ).toEqual([
      "NOT_PUBLISHED",
      "LESSON_CANCELLED",
      "LESSON_STARTED",
      "NOT_A_MEMBER",
      "ALREADY_REPORTED",
    ]);
  });

  it("refuses a lesson that has started, also exactly at the start", () => {
    expect(
      checkAbsence({ ...base, lesson: { ...base.lesson, startsAt: now } }, now),
    ).toEqual(["LESSON_STARTED"]);
  });

  it("sends a replacement student to cancel the booking instead", () => {
    expect(
      checkAbsence(
        { ...base, isMember: false, hasActiveReplacement: true },
        now,
      ),
    ).toEqual(["REPLACEMENT_BOOKING"]);
  });
});

describe("planAbsence", () => {
  const settings = { absenceCutoffMinutes: 1440, makeupCreditValidDays: 30 };
  const startsAt = at("2026-10-20", "17:00");

  it("group lesson before the cutoff: credit, the lesson runs", () => {
    const plan = planAbsence(
      { startsAt, type: "GROUP" },
      settings,
      TZ,
      at("2026-10-19", "17:00"),
    );
    expect(plan).toMatchObject({
      earnsCredit: true,
      credit: { validUntil: "2026-11-19" },
      cancelLesson: false,
    });
  });

  it("1-on-1 before the cutoff: credit and the lesson is cancelled", () => {
    const plan = planAbsence(
      { startsAt, type: "ONE_ON_ONE" },
      settings,
      TZ,
      at("2026-10-18", "09:00"),
    );
    expect(plan.earnsCredit).toBe(true);
    expect(plan.cancelLesson).toBe(true);
  });

  it("after the cutoff: no credit, and a 1-on-1 stays scheduled", () => {
    const late = at("2026-10-20", "16:00");
    for (const type of ["GROUP", "ONE_ON_ONE"] as const) {
      expect(planAbsence({ startsAt, type }, settings, TZ, late)).toEqual({
        earnsCredit: false,
        credit: null,
        cancelLesson: false,
      });
    }
  });

  it("applies the school's own settings", () => {
    const plan = planAbsence(
      { startsAt, type: "GROUP" },
      { absenceCutoffMinutes: 120, makeupCreditValidDays: 7 },
      TZ,
      at("2026-10-20", "15:00"),
    );
    expect(plan.credit?.validUntil).toBe("2026-10-27");
  });
});

describe("checkAbsenceDelete", () => {
  const now = at("2026-10-14", "12:00");
  const lessonStartsAt = at("2026-10-20", "17:00");

  it("refuses while the credit is used", () => {
    expect(
      checkAbsenceDelete({
        creditStatus: "USED",
        restoresLesson: false,
        lessonStartsAt,
        now,
      }),
    ).toBe("ABSENCE_CREDIT_USED");
  });

  it("allows an available, expired or missing credit", () => {
    for (const creditStatus of ["AVAILABLE", "EXPIRED", null] as const) {
      expect(
        checkAbsenceDelete({
          creditStatus,
          restoresLesson: false,
          lessonStartsAt,
          now,
        }),
      ).toBeNull();
    }
  });

  it("can't bring back a cancelled 1-on-1 that has started", () => {
    expect(
      checkAbsenceDelete({
        creditStatus: "AVAILABLE",
        restoresLesson: true,
        lessonStartsAt: now,
        now,
      }),
    ).toBe("LESSON_STARTED");
  });
});

describe("seatsTaken and buildRoster", () => {
  const members = [
    { id: "s1", name: "Ben" },
    { id: "s2", name: "Anna" },
    { id: "s3", name: "Cyril" },
  ];

  it("counts members minus absent plus replacements", () => {
    expect(
      seatsTaken({
        memberIds: ["s1", "s2", "s3"],
        absentIds: ["s2", "x"],
        replacementIds: ["r1"],
      }),
    ).toBe(3);
  });

  it("lists who is coming and who isn't, by name", () => {
    const roster = buildRoster({
      members,
      absences: [
        {
          studentId: "s3",
          reportedAt: at("2026-10-18", "10:00"),
          reason: "Doctor",
          viaOffice: true,
          hasCredit: false,
        },
      ],
      replacements: [{ id: "r1", name: "Abel", fromGroup: "B1 Morning" }],
    });
    expect(roster.coming.map((s) => [s.name, s.replacementFrom])).toEqual([
      ["Abel", "B1 Morning"],
      ["Anna", null],
      ["Ben", null],
    ]);
    expect(roster.notComing).toEqual([
      expect.objectContaining({
        id: "s3",
        reason: "Doctor",
        viaOffice: true,
        late: true,
      }),
    ]);
    expect(roster.seatsTaken).toBe(3);
  });
});

describe("buildRoster with late-cancelled replacements", () => {
  it("lists a replacement cancelled after the cutoff under not coming", () => {
    const roster = buildRoster({
      members: [{ id: "a", name: "Anna" }],
      absences: [],
      replacements: [],
      lateCancelled: [
        { id: "z", name: "Zoe", cancelledAt: at("2026-10-20", "16:00") },
      ],
    });
    expect(roster.coming.map((s) => s.id)).toEqual(["a"]);
    expect(roster.notComing).toEqual([
      expect.objectContaining({ id: "z", late: true, replacement: true }),
    ]);
    // A cancelled booking holds no seat.
    expect(roster.seatsTaken).toBe(1);
  });
});

describe("releaseCredit", () => {
  const now = at("2026-10-20", "12:00");

  it("keeps the expiry for the student's own release, EXPIRED once past", () => {
    const expiresAt = at("2026-10-25", "00:00");
    expect(releaseCredit({ expiresAt }, "STUDENT", TZ, now)).toEqual({
      status: "AVAILABLE",
      expiresAt,
    });
    expect(releaseCredit({ expiresAt: now }, "STUDENT", TZ, now).status).toBe(
      "EXPIRED",
    );
  });

  it("gives at least 7 whole local days when the school releases it", () => {
    const soon = releaseCredit(
      { expiresAt: at("2026-10-21", "00:00") },
      "SCHOOL",
      TZ,
      now,
    );
    expect(soon.status).toBe("AVAILABLE");
    // Valid until 27 Oct (today + 7), i.e. usable until 28 Oct 00:00 local.
    expect(validUntilOf(soon.expiresAt, TZ)).toBe("2026-10-27");
    expect(soon.expiresAt.getTime()).toBeGreaterThanOrEqual(
      now.getTime() + 7 * 24 * HOUR,
    );
    // A later expiry is kept.
    const later = at("2026-12-01", "00:00");
    expect(
      releaseCredit({ expiresAt: later }, "SCHOOL", TZ, now).expiresAt,
    ).toEqual(later);
    // Even an already expired credit comes back.
    expect(
      releaseCredit({ expiresAt: at("2026-10-01", "00:00") }, "SCHOOL", TZ, now)
        .status,
    ).toBe("AVAILABLE");
  });
});

describe("studentClashes", () => {
  const target = {
    id: "t",
    startsAt: at("2026-10-21", "17:00"),
    endsAt: at("2026-10-21", "18:30"),
  };
  it("finds overlaps, not back-to-back lessons, sorted by start", () => {
    const lessons = [
      {
        id: "b",
        startsAt: at("2026-10-21", "18:00"),
        endsAt: at("2026-10-21", "19:00"),
      },
      {
        id: "a",
        startsAt: at("2026-10-21", "16:00"),
        endsAt: at("2026-10-21", "17:30"),
      },
      {
        id: "before",
        startsAt: at("2026-10-21", "15:30"),
        endsAt: at("2026-10-21", "17:00"),
      },
      {
        id: "after",
        startsAt: at("2026-10-21", "18:30"),
        endsAt: at("2026-10-21", "19:30"),
      },
      { ...target },
    ];
    expect(studentClashes(target, lessons).map((l) => l.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("checkReplacement", () => {
  const now = at("2026-10-20", "12:00");
  const startsAt = at("2026-10-22", "10:00");
  const base = (): ReplacementCheckInput => ({
    target: {
      id: "target",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 90 * 60_000),
      status: "SCHEDULED",
      published: true,
      groupType: "GROUP",
      groupArchived: false,
      levelId: "B1",
      capacity: 14,
      seatsTaken: 10,
    },
    student: { id: "s1", levelId: "B1", isMemberOfTarget: false },
    bookings: [],
    credit: {
      id: "c1",
      studentId: "s1",
      status: "AVAILABLE",
      expiresAt: at("2026-11-19", "00:00"),
      sourceLessonId: "missed",
      fromOneOnOne: false,
      bookingId: null,
    },
    attending: [],
  });
  const codes = (input: ReplacementCheckInput, t = now) =>
    checkReplacement(input, t).map((r) => r.code);

  it("allows an eligible lesson", () => {
    expect(codes(base())).toEqual([]);
  });

  it("is NOT_FOUND without a target", () => {
    expect(codes({ ...base(), target: null })).toEqual(["NOT_FOUND"]);
  });

  it("refuses unpublished, cancelled, started and non-group lessons", () => {
    const input = base();
    input.target = {
      ...input.target!,
      published: false,
      status: "CANCELLED",
      groupType: "ONE_ON_ONE",
    };
    expect(codes(input, startsAt)).toEqual([
      "LESSON_NOT_PUBLISHED",
      "LESSON_CANCELLED",
      "LESSON_STARTED",
      "NOT_A_GROUP_LESSON",
    ]);
    const archived = base();
    archived.target = { ...archived.target!, groupArchived: true };
    expect(codes(archived)).toEqual(["NOT_A_GROUP_LESSON"]);
  });

  it("refuses the missed lesson itself and lessons already attended", () => {
    const same = base();
    same.credit = { ...same.credit!, sourceLessonId: "target" };
    expect(codes(same)).toEqual(["SAME_LESSON"]);
    const member = base();
    member.student = { ...member.student, isMemberOfTarget: true };
    expect(codes(member)).toEqual(["ALREADY_ATTENDING"]);
    const booked = base();
    booked.bookings = [{ id: "other", targetLessonId: "target" }];
    expect(codes(booked)).toEqual(["ALREADY_ATTENDING"]);
  });

  it("refuses someone else's, used, expired and 1-on-1 credits", () => {
    for (const credit of [
      { studentId: "s2" },
      { status: "USED" as const },
      { expiresAt: now },
      { fromOneOnOne: true },
    ]) {
      const input = base();
      input.credit = { ...input.credit!, ...credit };
      expect(codes(input)).toContain("CREDIT_UNAVAILABLE");
    }
    expect(codes({ ...base(), credit: null })).toEqual(["CREDIT_UNAVAILABLE"]);
  });

  it("refuses a target starting exactly at the credit's expiry", () => {
    const input = base();
    input.credit = { ...input.credit!, expiresAt: startsAt };
    expect(codes(input)).toEqual(["CREDIT_EXPIRES_FIRST"]);
    input.credit = {
      ...input.credit!,
      expiresAt: new Date(startsAt.getTime() + 1),
    };
    expect(codes(input)).toEqual([]);
  });

  it("compares levels by id, and needs one", () => {
    const other = base();
    other.target = { ...other.target!, levelId: "B2" };
    const reasons = checkReplacement(other, now);
    expect(reasons).toEqual([
      {
        code: "LEVEL_MISMATCH",
        key: "LEVEL_MISMATCH:B2",
        params: { levelId: "B2" },
      },
    ]);
    const none = base();
    none.student = { ...none.student, levelId: null };
    expect(codes(none)).toEqual(["NO_LEVEL"]);
  });

  it("needs a free seat in the lesson's room; no capacity means no limit", () => {
    const last = base();
    last.target = { ...last.target!, seatsTaken: 13 };
    expect(codes(last)).toEqual([]);
    const full = base();
    full.target = { ...full.target!, seatsTaken: 14 };
    expect(checkReplacement(full, now)).toEqual([
      {
        code: "ROOM_FULL",
        key: "ROOM_FULL:14",
        params: { taken: 15, capacity: 14 },
      },
    ]);
    const online = base();
    online.target = { ...online.target!, capacity: null, seatsTaken: 99 };
    expect(codes(online)).toEqual([]);
  });

  it("refuses a clash with a lesson the student attends", () => {
    const input = base();
    input.attending = [
      {
        id: "mine",
        startsAt: at("2026-10-22", "11:00"),
        endsAt: at("2026-10-22", "12:00"),
      },
    ];
    expect(checkReplacement(input, now)).toEqual([
      {
        code: "STUDENT_CLASH",
        key: "STUDENT_CLASH:mine",
        params: { lessonIds: ["mine"] },
      },
    ]);
    // Back-to-back is fine.
    input.attending = [
      {
        id: "mine",
        startsAt: at("2026-10-22", "11:30"),
        endsAt: at("2026-10-22", "12:00"),
      },
    ];
    expect(codes(input)).toEqual([]);
  });

  it("returns every failing reason in display order", () => {
    const input = base();
    input.target = { ...input.target!, levelId: "B2", seatsTaken: 14 };
    input.student = { ...input.student, isMemberOfTarget: true };
    input.credit = { ...input.credit!, expiresAt: startsAt };
    expect(codes(input)).toEqual([
      "ALREADY_ATTENDING",
      "CREDIT_EXPIRES_FIRST",
      "LEVEL_MISMATCH",
      "ROOM_FULL",
    ]);
  });
});

describe("reviewReplacement", () => {
  const now = at("2026-10-20", "12:00");
  const startsAt = at("2026-10-22", "10:00");
  // The booking under review ("b1") is already counted in the seats, is in
  // the student's bookings and attending lessons, and its credit is USED.
  const booked = (): ReplacementCheckInput => ({
    target: {
      id: "target",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 90 * 60_000),
      status: "SCHEDULED",
      published: true,
      groupType: "GROUP",
      groupArchived: false,
      levelId: "B1",
      capacity: 14,
      seatsTaken: 14,
    },
    student: { id: "s1", levelId: "B1", isMemberOfTarget: false },
    bookings: [{ id: "b1", targetLessonId: "target" }],
    credit: {
      id: "c1",
      studentId: "s1",
      status: "USED",
      expiresAt: at("2026-11-19", "00:00"),
      sourceLessonId: "missed",
      fromOneOnOne: false,
      bookingId: "b1",
    },
    attending: [
      {
        id: "target",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 90 * 60_000),
        bookingId: "b1",
      },
    ],
  });

  it("passes on a booking into an exactly full lesson", () => {
    expect(reviewReplacement(booked(), "b1", now)).toEqual([]);
    // The same input as a new booking: full, already attending, credit used.
    expect(checkReplacement(booked(), now).map((r) => r.code)).toEqual([
      "ALREADY_ATTENDING",
      "CREDIT_UNAVAILABLE",
      "ROOM_FULL",
    ]);
  });

  it("flags problems that appeared after booking", () => {
    const input = booked();
    input.target = { ...input.target!, seatsTaken: 15, levelId: "B2" };
    input.student = { ...input.student, isMemberOfTarget: true };
    input.attending = [
      ...input.attending,
      { id: "new", startsAt, endsAt: new Date(startsAt.getTime() + 60_000) },
    ];
    expect(reviewReplacement(input, "b1", now).map((r) => r.code)).toEqual([
      "ALREADY_ATTENDING",
      "LEVEL_MISMATCH",
      "ROOM_FULL",
      "STUDENT_CLASH",
    ]);
  });

  it("checks an override's new target without the booking", () => {
    const input = booked();
    input.target = { ...input.target!, id: "other", seatsTaken: 14 };
    // A full other lesson stays full: this booking holds no seat there.
    expect(reviewReplacement(input, "b1", now).map((r) => r.code)).toEqual([
      "ROOM_FULL",
    ]);
  });

  it("doesn't evaluate LESSON_STARTED", () => {
    expect(reviewReplacement(booked(), "b1", startsAt)).toEqual([]);
  });
});

describe("decideOverride", () => {
  const roomFull = {
    code: "ROOM_FULL" as const,
    key: "ROOM_FULL:14",
    params: { taken: 15, capacity: 14 },
  };
  it("needs every overridable reason acknowledged", () => {
    expect(decideOverride([], [])).toEqual({ ok: true, overridden: [] });
    expect(decideOverride([roomFull], [])).toMatchObject({
      ok: false,
      reason: "UNACKNOWLEDGED",
    });
    expect(decideOverride([roomFull], ["ROOM_FULL:14"])).toEqual({
      ok: true,
      overridden: [roomFull],
    });
  });
  it("never overrides a blocking reason", () => {
    const started = {
      code: "LESSON_CANCELLED" as const,
      key: "LESSON_CANCELLED",
      params: {},
    };
    expect(
      decideOverride([started, roomFull], ["LESSON_CANCELLED", "ROOM_FULL:14"]),
    ).toMatchObject({ ok: false, reason: "BLOCKED" });
  });
});

describe("planBookingCancel", () => {
  const startsAt = at("2026-10-22", "10:00");
  it("gives the credit back until the cutoff", () => {
    expect(
      planBookingCancel(startsAt, 1440, at("2026-10-21", "10:00")),
    ).toEqual({
      ok: true,
      cancelReason: "STUDENT",
      releaseCredit: true,
    });
  });
  it("is STUDENT_LATE after the cutoff, until the lesson starts", () => {
    expect(
      planBookingCancel(startsAt, 1440, at("2026-10-21", "10:01")),
    ).toEqual({
      ok: true,
      cancelReason: "STUDENT_LATE",
      releaseCredit: false,
    });
    expect(planBookingCancel(startsAt, 1440, startsAt)).toEqual({
      ok: false,
      reason: "LESSON_STARTED",
    });
  });
});
