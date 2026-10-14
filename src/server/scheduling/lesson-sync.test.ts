import { describe, expect, it } from "vitest";

import { generateLessonOccurrences } from "./generate-lessons";
import {
  applyGroupTeacherChange,
  type ExistingLesson,
  isEmptyPlan,
  type LessonSyncInput,
  type LessonSyncPlan,
  planGroupTeacherChange,
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

describe("planGroupTeacherChange (generator.md §5.6)", () => {
  const D = "2026-10-26";
  const NOW = new Date("2026-10-20T10:00:00Z");
  const tuesday = slot("tue", { weekday: 2 });

  /** The term's lessons with some history after D. */
  function lessons(): ExistingLesson[] {
    return stored([monday, tuesday]).map((l) => {
      if (l.id === "mon@2026-10-26") return { ...l, hasDependents: true };
      if (l.id === "tue@2026-10-27") {
        return {
          ...l,
          status: "CANCELLED" as const,
          cancelReason: "STUDENT_CANCELLED",
        };
      }
      if (l.id === "mon@2026-11-02") return { ...l, substituteTeacherId: "t2" };
      if (l.id === "tue@2026-11-03") {
        // Moved by hand to 11:00.
        return {
          ...l,
          startsAt: new Date(l.startsAt.getTime() + 2 * 3600_000),
          endsAt: new Date(l.endsAt.getTime() + 2 * 3600_000),
        };
      }
      return l;
    });
  }
  const adHoc = (id: string, teacherId: string, day: string) => ({
    ...stored([monday])[0],
    id,
    timetableSlotId: null,
    occurrenceDate: null,
    teacherId,
    startsAt: new Date(`${day}T15:00:00Z`),
    endsAt: new Date(`${day}T16:00:00Z`),
  });
  const input = (extra = {}) => ({
    slots: [monday, tuesday],
    lessons: [
      ...lessons(),
      adHoc("adhoc-mine", "t1", "2026-10-29"),
      adHoc("adhoc-other", "t3", "2026-10-29"),
      adHoc("adhoc-before", "t1", "2026-10-22"),
    ],
    oldTeacherId: "t1",
    newTeacherId: "t2",
    from: D,
    now: NOW,
    timeZone: TZ,
    ...extra,
  });

  /** Applies the plan in memory, the new slots with ids `<old>-next`. */
  function applyChange(
    slots: SlotInfo[],
    existing: ExistingLesson[],
    plan: ReturnType<typeof planGroupTeacherChange>,
  ) {
    const nextId = new Map<string, string>();
    const outSlots = [...slots];
    for (const change of plan.slots) {
      if (change.kind === "update") {
        outSlots[outSlots.findIndex((s) => s.id === change.slot.id)] =
          change.slot;
      } else {
        outSlots[outSlots.findIndex((s) => s.id === change.ended.id)] =
          change.ended;
        outSlots.push({ ...change.next, id: `${change.ended.id}-next` });
        nextId.set(change.ended.id, `${change.ended.id}-next`);
      }
    }
    const outLessons = applyGroupTeacherChange(
      existing,
      plan,
      "t2",
      (id) => nextId.get(id) ?? id,
    );
    return { slots: outSlots, lessons: outLessons };
  }

  it("splits the slots on D and re-points every lesson from D", () => {
    const plan = planGroupTeacherChange(input());
    // (`toEqual` ignores the copies' `id: undefined`.)
    expect(plan.slots).toEqual([
      {
        kind: "split",
        ended: { ...monday, validUntil: "2026-10-25" },
        next: { ...monday, id: undefined, teacherId: "t2", validFrom: D },
      },
      {
        kind: "split",
        ended: { ...tuesday, validUntil: "2026-10-25" },
        next: { ...tuesday, id: undefined, teacherId: "t2", validFrom: D },
      },
    ]);
    expect(plan.repoint).toEqual([
      {
        lessonId: "mon@2026-10-26",
        fromSlotId: "mon",
        setTeacher: true,
        clearSubstitute: false,
      },
      {
        lessonId: "mon@2026-11-02",
        fromSlotId: "mon",
        setTeacher: true,
        clearSubstitute: true,
      },
      {
        lessonId: "tue@2026-10-27",
        fromSlotId: "tue",
        setTeacher: false,
        clearSubstitute: false,
      },
      {
        lessonId: "tue@2026-11-03",
        fromSlotId: "tue",
        setTeacher: true,
        clearSubstitute: false,
      },
    ]);
    expect(plan.adHoc).toEqual([
      { lessonId: "adhoc-mine", clearSubstitute: false },
    ]);
    expect(plan.checkLessons).toEqual(["tue@2026-11-03", "adhoc-mine"]);
  });

  it("deletes and cancels nothing, and is idempotent with planLessonSync", () => {
    const before = input();
    const plan = planGroupTeacherChange(before);
    const after = applyChange(before.slots, before.lessons, plan);
    const generated = after.lessons.filter((l) => l.timetableSlotId);
    const sync = planLessonSync(
      base({ slots: after.slots, lessons: generated, from: D, now: NOW }),
    );
    // Every date from D is taken on the new slots: nothing to create, and
    // the cancelled 1-on-1 does not come back.
    expect(sync).toEqual({ create: [], remove: [], cancel: [] });
    const cancelled = after.lessons.find((l) => l.id === "tue@2026-10-27")!;
    expect(cancelled).toMatchObject({
      status: "CANCELLED",
      cancelReason: "STUDENT_CANCELLED",
      timetableSlotId: "tue-next",
      teacherId: "t1",
    });
    // History stays on the same row; lessons before D are untouched.
    expect(after.lessons.find((l) => l.id === "mon@2026-10-26")).toMatchObject({
      hasDependents: true,
      teacherId: "t2",
      timetableSlotId: "mon-next",
    });
    for (const l of after.lessons.filter(
      (x) => x.occurrenceDate && x.occurrenceDate < D,
    )) {
      expect(before.lessons.find((x) => x.id === l.id)).toEqual(l);
    }
    expect(after.lessons.find((l) => l.id === "adhoc-other")!.teacherId).toBe(
      "t3",
    );
    expect(after.lessons.find((l) => l.id === "adhoc-before")!.teacherId).toBe(
      "t1",
    );
    expect(planGroupTeacherChange({ ...before, ...after }).repoint).toEqual([]);
  });

  it("creates the occurrences that were not generated yet", () => {
    const before = input({
      lessons: lessons().filter((l) => l.id !== "mon@2026-11-02"),
    });
    const after = applyChange(
      before.slots,
      before.lessons,
      planGroupTeacherChange(before),
    );
    const sync = planLessonSync(
      base({ slots: after.slots, lessons: after.lessons, from: D, now: NOW }),
    );
    expect(
      sync.create.map((o) => [o.timetableSlotId, o.date, o.teacherId]),
    ).toEqual([["mon-next", "2026-11-02", "t2"]]);
    expect(sync.remove).toEqual([]);
    expect(sync.cancel).toEqual([]);
  });

  it("re-points a lesson from D moved to a time that has started, keeping its teacher", () => {
    const early = lessons().map((l) =>
      l.id === "mon@2026-10-26"
        ? {
            ...l,
            startsAt: new Date("2026-10-20T07:00:00Z"),
            endsAt: new Date("2026-10-20T08:30:00Z"),
          }
        : l,
    );
    const before = input({ lessons: early });
    const plan = planGroupTeacherChange(before);
    expect(plan.repoint[0]).toEqual({
      lessonId: "mon@2026-10-26",
      fromSlotId: "mon",
      setTeacher: false,
      clearSubstitute: false,
    });
    expect(plan.checkLessons).not.toContain("mon@2026-10-26");
    const after = applyChange(before.slots, before.lessons, plan);
    expect(after.lessons.find((l) => l.id === "mon@2026-10-26")).toMatchObject({
      timetableSlotId: "mon-next",
      teacherId: "t1",
    });
    // No second lesson for 26 October.
    const sync = planLessonSync(
      base({ slots: after.slots, lessons: after.lessons, from: D, now: NOW }),
    );
    expect(sync).toEqual({ create: [], remove: [], cancel: [] });
  });

  it("changes a slot that starts on or after D in place", () => {
    const later = slot("later", { validFrom: "2026-11-02" });
    const plan = planGroupTeacherChange(
      input({ slots: [later], lessons: stored([later]) }),
    );
    expect(plan.slots).toEqual([
      { kind: "update", slot: { ...later, teacherId: "t2" } },
    ]);
    expect(plan.repoint).toEqual([
      {
        lessonId: "later@2026-11-02",
        fromSlotId: "later",
        setTeacher: true,
        clearSubstitute: false,
      },
    ]);
  });

  it("leaves slots that already have the new teacher or ended before D", () => {
    const plan = planGroupTeacherChange(
      input({
        slots: [
          slot("theirs", { teacherId: "t2" }),
          slot("old", { validUntil: "2026-10-20" }),
        ],
        lessons: [],
      }),
    );
    expect(plan.slots).toEqual([]);
  });

  it("applyGroupTeacherChange maps the lessons for the would-be calendar", () => {
    const before = input();
    const plan = planGroupTeacherChange(before);
    const after = applyGroupTeacherChange(
      before.lessons,
      plan,
      "t2",
      (id) => `${id}-next`,
    );
    const byId = new Map(after.map((l) => [l.id, l]));
    expect(byId.get("mon@2026-11-02")).toMatchObject({
      timetableSlotId: "mon-next",
      teacherId: "t2",
      substituteTeacherId: null,
    });
    // Cancelled lessons move but keep their teacher.
    expect(byId.get("tue@2026-10-27")).toMatchObject({
      timetableSlotId: "tue-next",
      teacherId: "t1",
    });
    expect(byId.get("adhoc-mine")).toMatchObject({
      timetableSlotId: null,
      teacherId: "t2",
    });
    // Untouched lessons are the same objects.
    for (const id of ["mon@2026-10-19", "adhoc-other", "adhoc-before"]) {
      expect(byId.get(id)).toBe(before.lessons.find((l) => l.id === id));
    }
  });
});
