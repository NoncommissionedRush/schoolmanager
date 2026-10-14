import { describe, expect, it } from "vitest";

import { generateLessonOccurrences } from "./generate-lessons";
import {
  type ExistingLesson,
  isEmptyPlan,
  type LessonSyncInput,
  type LessonSyncPlan,
  planLessonSync,
  planSlotCarryOver,
  planSlotEdit,
  type SlotCarryOverInput,
} from "./lesson-sync";
import { h, slot, TERM, TZ } from "./testing/fixtures";
import { addDays } from "./time";
import type { HolidayInfo, SlotInfo } from "./types";

/** Stored lessons for `slots`, as publishing would create them. */
function stored(
  slots: SlotInfo[],
  holidays: HolidayInfo[] = [],
): ExistingLesson[] {
  return generateLessonOccurrences({
    slots,
    term: TERM,
    holidays,
    timeZone: TZ,
  }).map((o) => ({
    id: `${o.timetableSlotId}@${o.date}`,
    termId: TERM.id,
    timetableSlotId: o.timetableSlotId,
    occurrenceDate: o.date,
    groupId: o.groupId,
    teacherId: o.teacherId,
    substituteTeacherId: null,
    roomId: o.roomId,
    startsAt: o.startsAt,
    endsAt: o.endsAt,
    status: "SCHEDULED",
    hasDependents: false,
  }));
}

/** Applies a plan the way the service does, in memory. */
function apply(
  lessons: ExistingLesson[],
  plan: LessonSyncPlan,
): ExistingLesson[] {
  const removed = new Set(plan.remove);
  const cancelled = new Map(plan.cancel.map((c) => [c.id, c.reason]));
  return [
    ...lessons
      .filter((l) => !removed.has(l.id))
      .map((l) =>
        cancelled.has(l.id) ? { ...l, status: "CANCELLED" as const } : l,
      ),
    ...plan.create.map((o) => ({
      id: `${o.timetableSlotId}@${o.date}`,
      termId: TERM.id,
      timetableSlotId: o.timetableSlotId,
      occurrenceDate: o.date,
      groupId: o.groupId,
      teacherId: o.teacherId,
      substituteTeacherId: null,
      roomId: o.roomId,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      status: "SCHEDULED" as const,
      hasDependents: false,
    })),
  ];
}

const monday = slot("mon");
const base = (extra: Partial<LessonSyncInput>): LessonSyncInput => ({
  term: TERM,
  slots: [monday],
  holidays: [],
  lessons: [],
  timeZone: TZ,
  from: TERM.startDate,
  ...extra,
});
const ids = (lessons: { id: string }[]) => lessons.map((l) => l.id);

describe("planLessonSync", () => {
  it("creates every lesson of a freshly published term", () => {
    const plan = planLessonSync(base({}));
    expect(plan.create.map((o) => o.date)).toEqual([
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
      "2026-11-02",
    ]);
    expect(plan.remove).toEqual([]);
    expect(plan.cancel).toEqual([]);
  });

  it("is idempotent", () => {
    const lessons = apply([], planLessonSync(base({})));
    expect(isEmptyPlan(planLessonSync(base({ lessons })))).toBe(true);
  });

  it("only creates lessons from `from` on", () => {
    const plan = planLessonSync(base({ from: "2026-10-20" }));
    expect(plan.create.map((o) => o.date)).toEqual([
      "2026-10-26",
      "2026-11-02",
    ]);
  });

  it("removes only future SCHEDULED lessons when a slot ends", () => {
    const lessons = stored([monday]);
    lessons[0].status = "COMPLETED";
    const ended = { ...monday, validUntil: "2026-10-20" };
    const plan = planLessonSync(
      base({ slots: [ended], lessons, from: "2026-10-14" }),
    );
    expect(plan).toEqual({
      create: [],
      remove: ["mon@2026-10-26", "mon@2026-11-02"],
      cancel: [],
    });
  });

  it("never touches lessons before `from`, even if no longer wanted", () => {
    const lessons = stored([monday]);
    const ended = { ...monday, validUntil: "2026-10-01" };
    const plan = planLessonSync(
      base({ slots: [ended], lessons, from: "2026-10-27" }),
    );
    expect(plan.remove).toEqual(["mon@2026-11-02"]);
  });

  it("cancels instead of deleting lessons with history or manual edits", () => {
    const lessons = stored([monday]);
    lessons[1].hasDependents = true; // e.g. an absence report
    lessons[2].substituteTeacherId = "t2";
    lessons[3].startsAt = new Date(lessons[3].startsAt.getTime() + 36e5);
    const ended = { ...monday, validUntil: "2026-10-12" };
    const plan = planLessonSync(base({ slots: [ended], lessons }));
    expect(plan.remove).toEqual([]);
    expect(plan.cancel).toEqual([
      { id: "mon@2026-10-19", reason: "TIMETABLE_CHANGED" },
      { id: "mon@2026-10-26", reason: "TIMETABLE_CHANGED" },
      { id: "mon@2026-11-02", reason: "TIMETABLE_CHANGED" },
    ]);
  });

  it("removes or cancels lessons on a new holiday and restores them when it is deleted", () => {
    const holiday: HolidayInfo = {
      id: "hol",
      name: "Break",
      termId: null,
      startDate: "2026-10-19",
      endDate: "2026-10-26",
    };
    const lessons = stored([monday]);
    lessons[2].hasDependents = true;
    const withHoliday = planLessonSync(base({ lessons, holidays: [holiday] }));
    expect(withHoliday).toEqual({
      create: [],
      remove: ["mon@2026-10-19"],
      cancel: [{ id: "mon@2026-10-26", reason: "HOLIDAY" }],
    });

    const after = apply(lessons, withHoliday);
    const restored = planLessonSync(base({ lessons: after }));
    // The removed lesson comes back; the cancelled one stays cancelled.
    expect(restored.create.map((o) => o.date)).toEqual(["2026-10-19"]);
    expect(restored.cancel).toEqual([]);
  });

  it("never touches or creates lessons that already started", () => {
    const lessons = stored([monday]);
    const ended = { ...monday, validUntil: "2026-10-11" };
    // 2026-10-19 09:30 local: that day's 09:00 lesson is under way.
    const now = new Date("2026-10-19T07:30:00Z");
    const plan = planLessonSync(
      base({ slots: [ended], lessons, from: "2026-10-19", now }),
    );
    expect(plan.remove).toEqual(["mon@2026-10-26", "mon@2026-11-02"]);
    const fresh = planLessonSync(base({ from: "2026-10-19", now }));
    expect(fresh.create.map((o) => o.date)).toEqual([
      "2026-10-26",
      "2026-11-02",
    ]);
  });

  it("keeps a wanted lesson that was moved by hand", () => {
    const lessons = stored([monday]);
    lessons[1].startsAt = new Date(lessons[1].startsAt.getTime() + 36e5);
    expect(isEmptyPlan(planLessonSync(base({ lessons })))).toBe(true);
  });

  it("removes lessons beyond a shortened term", () => {
    const lessons = stored([monday]);
    const plan = planLessonSync(
      base({ lessons, term: { ...TERM, endDate: "2026-10-31" } }),
    );
    expect(plan.remove).toEqual(["mon@2026-11-02"]);
  });

  it("moves a slot mid-term by splitting it", () => {
    // Monday 09:00 → Tuesday 17:00 from 2026-10-20.
    const lessons = stored([monday]);
    const effectiveFrom = "2026-10-20";
    const ending = { ...monday, validUntil: "2026-10-19" };
    const removal = planLessonSync(
      base({ slots: [ending], lessons, from: effectiveFrom }),
    );
    const remaining = apply(lessons, removal);
    expect(ids(remaining)).toEqual(["mon@2026-10-12", "mon@2026-10-19"]);

    const edit = planSlotEdit(
      monday,
      { weekday: 2, startMinute: h(17), endMinute: h(18, 30) },
      effectiveFrom,
      remaining.length,
    );
    expect(edit.kind).toBe("split");
    if (edit.kind !== "split") return;
    expect(edit.ended.validUntil).toBe("2026-10-19");
    const next = { ...edit.next, id: "tue" };
    expect(next).toMatchObject({ weekday: 2, validFrom: effectiveFrom });

    const creation = planLessonSync(
      base({
        slots: [edit.ended, next],
        lessons: remaining,
        from: effectiveFrom,
      }),
    );
    expect(
      creation.create.map((o) => `${o.timetableSlotId}@${o.date}`),
    ).toEqual(["tue@2026-10-20", "tue@2026-10-27", "tue@2026-11-03"]);
    expect(creation.remove).toEqual([]);
  });
});

describe("planSlotEdit", () => {
  it("edits a slot without lessons in place", () => {
    expect(planSlotEdit(monday, { roomId: "r2" }, null, 0)).toEqual({
      kind: "update",
      slot: { ...monday, roomId: "r2" },
    });
  });

  it("moves validFrom forward when a slot without lessons changes from a date", () => {
    const plan = planSlotEdit(monday, { roomId: "r2" }, "2026-10-20", 0);
    expect(plan).toMatchObject({
      kind: "update",
      slot: { validFrom: "2026-10-20" },
    });
  });

  it("keeps a later start date when splitting", () => {
    const later = { ...monday, validFrom: "2026-10-26" };
    expect(
      planSlotEdit(later, { roomId: "r2" }, "2026-10-19", 1),
    ).toMatchObject({
      kind: "split",
      ended: { validUntil: "2026-10-25" },
      next: { validFrom: "2026-10-26", roomId: "r2" },
    });
  });

  it("refuses a whole-slot edit once lessons exist", () => {
    expect(() => planSlotEdit(monday, {}, null, 3)).toThrow();
  });
});

describe("planSlotCarryOver", () => {
  // Monday lessons 10-12, 10-19, 10-26, 11-02; split from Wednesday 10-21.
  const D = "2026-10-21";
  const ended = { ...monday, validUntil: addDays(D, -1) };
  const old = stored([monday]);
  const carry = (
    nextExtra: Partial<SlotInfo>,
    extra: Partial<SlotCarryOverInput> = {},
  ) =>
    planSlotCarryOver({
      ended,
      next: slot("next", { validFrom: D, ...nextExtra }),
      term: TERM,
      holidays: [],
      lessons: old,
      cancelling: ["mon@2026-10-26"],
      timeZone: TZ,
      from: D,
      ...extra,
    });

  it("pairs a cancelled lesson with the same week's new occurrence", () => {
    expect(carry({ startMinute: h(11), endMinute: h(12) })).toEqual([
      {
        fromLessonId: "mon@2026-10-26",
        toSlotId: "next",
        toDate: "2026-10-26",
        cancelSuccessor: null,
      },
    ]);
    // Monday → Thursday stays in the same ISO week.
    expect(carry({ weekday: 4 })).toMatchObject([{ toDate: "2026-10-29" }]);
  });

  it("has no successor when the new weekday falls before the split date", () => {
    // A Friday slot moved to Monday from Wednesday 10-21: the Friday 10-23
    // lesson's week has its Monday (10-19) before the split.
    const friday = slot("mon", { weekday: 5 });
    const fridays = stored([friday]);
    expect(
      carry(
        { weekday: 1 },
        {
          ended: { ...friday, validUntil: addDays(D, -1) },
          lessons: fridays,
          cancelling: ["mon@2026-10-23", "mon@2026-10-30"],
        },
      ),
    ).toEqual([
      {
        fromLessonId: "mon@2026-10-30",
        toSlotId: "next",
        toDate: "2026-10-26",
        cancelSuccessor: null,
      },
    ]);
  });

  it("creates the successor of a cancelled 1-on-1 cancelled the same way", () => {
    const lessons = old.map((l) =>
      l.id === "mon@2026-11-02"
        ? {
            ...l,
            status: "CANCELLED" as const,
            cancelReason: "STUDENT_CANCELLED",
          }
        : l.id === "mon@2026-10-26"
          ? { ...l, status: "CANCELLED" as const, cancelReason: "RESCHEDULED" }
          : l,
    );
    expect(carry({ weekday: 2 }, { lessons, cancelling: [] })).toEqual([
      {
        fromLessonId: "mon@2026-10-26",
        toSlotId: "next",
        toDate: "2026-10-27",
        cancelSuccessor: "RESCHEDULED",
      },
      {
        fromLessonId: "mon@2026-11-02",
        toSlotId: "next",
        toDate: "2026-11-03",
        cancelSuccessor: "STUDENT_CANCELLED",
      },
    ]);
    // Cancelled for another reason (a holiday, the school): nothing follows.
    const holiday = lessons.map((l) => ({ ...l, cancelReason: "HOLIDAY" }));
    expect(carry({}, { lessons: holiday, cancelling: [] })).toEqual([]);
  });

  it("carries nothing to a holiday, a started lesson or another group", () => {
    const holidays = [
      {
        id: "hol",
        name: "Break",
        termId: null,
        startDate: "2026-10-26",
        endDate: "2026-10-26",
      },
    ];
    expect(carry({}, { holidays })).toEqual([]);
    expect(carry({}, { now: new Date("2026-10-26T08:00:00Z") })).toEqual([]);
    expect(carry({ groupId: "g2" })).toEqual([]);
  });

  it("ignores lessons the split doesn't cancel and the old slot's past", () => {
    expect(carry({}, { cancelling: [] })).toEqual([]);
    expect(carry({}, { cancelling: ["mon@2026-10-19"] })).toEqual([]);
  });
});
