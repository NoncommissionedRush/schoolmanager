import { describe, expect, it } from "vitest";

import type { Conflict } from "@/server/scheduling";

import {
  acknowledgementsFromAudit,
  clampToTerm,
  defaultAsOf,
  defaultEndDate,
  defaultTeacherForGroup,
  issueRows,
  occurrenceSummary,
  pickTerm,
  publishSummary,
  showChangedOn,
  slotIssueState,
  slotsAsOf,
  splitDatesFromAudit,
} from "./editor";

const term = (id: string, startDate: string, endDate: string) => ({
  id,
  name: id,
  startDate,
  endDate,
  publishedAt: null,
});

const conflict = (
  key: string,
  severity: Conflict["severity"] = "overridable",
): Conflict => ({
  type:
    severity === "blocking" ? "TEACHER_DOUBLE_BOOKED" : "OUTSIDE_SCHOOL_HOURS",
  severity,
  key,
  dates: [],
  params: {},
  refs: {},
});

describe("pickTerm", () => {
  const terms = [
    term("spring", "2027-02-01", "2027-06-30"),
    term("autumn", "2026-09-14", "2027-01-29"),
    term("old", "2026-02-01", "2026-06-30"),
  ];

  it("prefers the term in the URL", () => {
    expect(pickTerm(terms, "old", "2026-10-14")?.id).toBe("old");
  });

  it("falls back to the current, then the next, then the newest term", () => {
    expect(pickTerm(terms, "unknown", "2026-10-14")?.id).toBe("autumn");
    expect(pickTerm(terms, undefined, "2026-08-01")?.id).toBe("autumn");
    expect(pickTerm(terms, undefined, "2028-01-01")?.id).toBe("spring");
    expect(pickTerm([], undefined, "2026-10-14")).toBeNull();
  });
});

describe("As of", () => {
  const autumn = term("autumn", "2026-09-14", "2027-01-29");

  it("defaults to today inside the term, else its first day", () => {
    expect(defaultAsOf(autumn, "2026-10-14")).toBe("2026-10-14");
    expect(defaultAsOf(autumn, "2026-08-01")).toBe("2026-09-14");
    expect(defaultAsOf(autumn, "2027-03-01")).toBe("2026-09-14");
  });

  it("clamps into the term", () => {
    expect(clampToTerm("2026-01-01", autumn)).toBe("2026-09-14");
    expect(clampToTerm("2030-01-01", autumn)).toBe("2027-01-29");
    expect(clampToTerm("2026-11-11", autumn)).toBe("2026-11-11");
  });

  it("shows only the slots in effect on that date", () => {
    const slots = [
      { id: "always", validFrom: null, validUntil: null },
      { id: "ended", validFrom: null, validUntil: "2026-10-25" },
      { id: "later", validFrom: "2026-10-26", validUntil: null },
    ];
    expect(slotsAsOf(slots, "2026-10-20").map((s) => s.id)).toEqual([
      "always",
      "ended",
    ]);
    expect(slotsAsOf(slots, "2026-10-26").map((s) => s.id)).toEqual([
      "always",
      "later",
    ]);
  });
});

describe("acknowledgements from the audit log", () => {
  const at = (iso: string) => new Date(iso);

  it("keeps the latest override per slot and follows splits", () => {
    const acks = acknowledgementsFromAudit([
      {
        entityId: "s1",
        action: "timetable_slot.created",
        createdAt: at("2026-09-01T10:00:00Z"),
        actorName: "Alexandra",
        data: { overridden: [{ key: "A" }, { key: "B" }] },
      },
      {
        entityId: "s1",
        action: "timetable_slot.updated",
        createdAt: at("2026-10-01T10:00:00Z"),
        actorName: "Boris",
        data: { overridden: [{ key: "C" }], newSlotId: "s2" },
      },
      {
        entityId: "s3",
        action: "timetable_slot.deleted",
        createdAt: at("2026-10-01T10:00:00Z"),
        actorName: "Boris",
        data: {},
      },
    ]);
    expect(acks.get("s1")).toEqual({
      keys: ["A", "B"],
      actorName: "Alexandra",
      at: "2026-09-01T10:00:00.000Z",
    });
    expect(acks.get("s2")?.keys).toEqual(["C"]);
    expect(acks.has("s3")).toBe(false);
  });

  it("finds when a split slot took effect", () => {
    const splits = splitDatesFromAudit([
      {
        action: "timetable_slot.updated",
        data: { newSlotId: "s2", effectiveFrom: "2026-10-26" },
      },
      {
        action: "timetable_slot.updated",
        data: { effectiveFrom: "2026-10-26" },
      },
    ]);
    expect([...splits]).toEqual([["s2", "2026-10-26"]]);
  });

  it("shows 'Changed on' for 14 days", () => {
    expect(showChangedOn("2026-10-26", "2026-10-25")).toBe(false);
    expect(showChangedOn("2026-10-26", "2026-10-26")).toBe(true);
    expect(showChangedOn("2026-10-26", "2026-11-08")).toBe(true);
    expect(showChangedOn("2026-10-26", "2026-11-09")).toBe(false);
    expect(showChangedOn(undefined, "2026-11-09")).toBe(false);
  });
});

describe("slot issue state", () => {
  it("ranks blocking over unacknowledged over acknowledged", () => {
    expect(slotIssueState([], [])).toBeNull();
    expect(slotIssueState([conflict("w")], ["w"])).toBe("acknowledged");
    expect(slotIssueState([conflict("w"), conflict("x")], ["w"])).toBe(
      "warning",
    );
    expect(
      slotIssueState([conflict("b", "blocking"), conflict("w")], ["w"]),
    ).toBe("blocking");
  });

  it("lists issues: conflicts first, acknowledged warnings only on request", () => {
    const bySlot = {
      s2: [conflict("w1"), conflict("w2")],
      s1: [conflict("b1", "blocking")],
    };
    const acked = (id: string) => (id === "s2" ? ["w1"] : []);
    expect(
      issueRows(bySlot, acked, false).map((r) => [r.slotId, r.conflict.key]),
    ).toEqual([
      ["s1", "b1"],
      ["s2", "w2"],
    ]);
    expect(
      issueRows(bySlot, acked, true).map((r) => [
        r.conflict.key,
        r.acknowledged,
      ]),
    ).toEqual([
      ["b1", false],
      ["w2", false],
      ["w1", true],
    ]);
  });
});

describe("publishSummary", () => {
  const autumn = term("autumn", "2026-09-14", "2027-01-29");

  it("creates lessons from the later of term start and today", () => {
    expect(publishSummary(autumn, 3, {}, "2026-10-14")).toMatchObject({
      slots: 3,
      rangeStart: "2026-10-14",
      rangeEnd: "2027-01-29",
      blockingCount: 0,
    });
    expect(publishSummary(autumn, 3, {}, "2026-08-01").rangeStart).toBe(
      "2026-09-14",
    );
  });

  it("counts warnings and lists the slots that block publishing", () => {
    const summary = publishSummary(
      autumn,
      3,
      {
        s2: [conflict("b", "blocking"), conflict("w")],
        s1: [conflict("w2")],
      },
      "2026-10-14",
    );
    expect(summary).toMatchObject({
      warnings: 2,
      blockingCount: 1,
      blockingSlots: ["s2"],
    });
  });
});

describe("slot sheet helpers", () => {
  const autumn = { startDate: "2026-09-14", endDate: "2026-10-11" };

  it("counts lessons and dates skipped for holidays", () => {
    // Mondays: 14, 21, 28 Sep, 5 Oct; 28 Sep is a holiday.
    expect(
      occurrenceSummary(
        { weekday: 1, validFrom: null, validUntil: null },
        autumn,
        [{ startDate: "2026-09-28", endDate: "2026-09-28" }],
      ),
    ).toEqual({
      count: 3,
      skipped: 1,
      first: "2026-09-14",
      last: "2026-10-05",
    });
    expect(
      occurrenceSummary(
        { weekday: 1, validFrom: "2026-10-06", validUntil: null },
        autumn,
        [],
      ),
    ).toEqual({ count: 0, skipped: 0, first: null, last: null });
  });

  it("prefills the teacher of the group's other slots", () => {
    const slots = [
      { groupId: "g1", teacherId: "t2" },
      { groupId: "g1", teacherId: "t1" },
      { groupId: "g1", teacherId: "t2" },
      { groupId: "g2", teacherId: "t3" },
    ];
    expect(defaultTeacherForGroup(slots, "g1")).toBe("t2");
    expect(defaultTeacherForGroup(slots, "g9")).toBeNull();
  });

  it("ends by default on the last lesson within a week, never before today", () => {
    const longTerm = { startDate: "2026-09-14", endDate: "2027-01-29" };
    const monday = { weekday: 1, validFrom: null, validUntil: null };
    // Today Wednesday 14 Oct → next Monday 19 Oct is within 7 days.
    expect(defaultEndDate(monday, longTerm, "2026-10-14")).toBe("2026-10-19");
    // No occurrence left within the week → today.
    expect(
      defaultEndDate(
        { ...monday, validUntil: "2026-10-05" },
        longTerm,
        "2026-10-14",
      ),
    ).toBe("2026-10-14");
  });
});
