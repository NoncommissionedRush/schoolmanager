import { describe, expect, it } from "vitest";

import {
  buildRoster,
  checkAbsence,
  checkAbsenceDelete,
  creditExpiry,
  creditState,
  cutoffAt,
  daysLeft,
  earnsCredit,
  planAbsence,
  seatsTaken,
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
