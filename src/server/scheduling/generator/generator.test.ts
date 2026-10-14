import { describe, expect, it } from "vitest";

import {
  build,
  grp,
  h,
  LEVEL_A,
  LEVEL_B,
  liveSlot,
  lt,
  MON_9,
  tch,
  teacherOf,
} from "../testing/generator-fixtures";
import { lesson } from "../testing/fixtures";
import {
  assignTeachers,
  checkGeneratorReadiness,
  draftTeacherOptions,
  evaluateDraft,
  fingerprintPayload,
} from ".";

// Rules of docs/architecture/generator.md on small hand-built schools.
// Term: Monday 2026-10-12 … Sunday 2026-11-08.

describe("readiness (§2.5)", () => {
  it("classifies every group", () => {
    const input = build(
      [
        grp("ready", LEVEL_A, [MON_9("a")]),
        grp("skipped", LEVEL_A, [lt("b", 2, h(9), h(10))], { skipped: true }),
        grp("no-times", LEVEL_A, []),
        grp("archived-room", LEVEL_A, [lt("c", 3, h(9), h(10), "old")]),
        grp("clash-1", LEVEL_A, [lt("d", 4, h(9), h(10), "shared")]),
        grp("clash-2", LEVEL_A, [lt("e", 4, h(9, 30), h(10, 30), "shared")]),
        grp("uncovered", LEVEL_B, [lt("f", 5, h(9), h(10))]),
      ],
      [tch("t1", [LEVEL_A]), tch("t2", [LEVEL_B], { archived: true })],
    );
    input.context = {
      ...input.context,
      rooms: input.context.rooms.map((r) =>
        r.id === "old" ? { ...r, archived: true } : r,
      ),
    };
    const readiness = checkGeneratorReadiness(input);
    const status = Object.fromEntries(
      readiness.groups.map((g) => [g.groupId, g.status]),
    );
    expect(status).toEqual({
      ready: "READY",
      skipped: "SKIPPED",
      "no-times": "NO_LESSON_TIMES",
      "archived-room": "NO_ROOM",
      "clash-1": "TIMES_CLASH",
      "clash-2": "TIMES_CLASH",
      uncovered: "LEVEL_UNCOVERED",
    });
    expect(readiness.checks.noTimes).toEqual(["archived-room", "no-times"]);
    expect(readiness.checks.roomClash).toEqual([
      { groupId: "clash-1", otherGroupId: "clash-2", roomId: "shared" },
    ]);
    expect(readiness.checks.levelUncovered).toEqual([LEVEL_B]);
    expect(readiness.checks.teachersNoLevels).toEqual([]);
  });

  it("warns when more groups run at once than teachers can take them", () => {
    const input = build(
      [
        grp("g1", LEVEL_A, [MON_9("a")]),
        grp("g2", LEVEL_A, [MON_9("b")]),
        grp("g3", LEVEL_A, [MON_9("c")]),
      ],
      [tch("t1", [LEVEL_A]), tch("t2", [LEVEL_A])],
    );
    const { checks } = checkGeneratorReadiness(input);
    expect(checks.timeCrunch).toEqual([
      { weekday: 1, minute: h(9), levelId: LEVEL_A, groups: 3, teachers: 2 },
    ]);
    expect(checks.hours.neededMinutes).toBe(270);
  });

  it("keeps student clashes as warnings, not exclusions", () => {
    const input = build(
      [grp("g1", LEVEL_A, [MON_9("a")]), grp("g2", LEVEL_A, [MON_9("b")])],
      [tch("t1", [LEVEL_A]), tch("t2", [LEVEL_A])],
    );
    input.context = {
      ...input.context,
      groups: input.context.groups.map((g) => ({ ...g, studentIds: ["s1"] })),
    };
    const result = assignTeachers(input);
    expect(result.readiness.checks.studentClash).toEqual(["g1", "g2"]);
    expect(result.final.unassignedGroups).toBe(0);
    expect(
      result.warnings
        .find((w) => w.groupId === "g1")!
        .conflicts.map((c) => c.type),
    ).toEqual(["STUDENT_DOUBLE_BOOKED"]);
  });
});

describe("hard rules (§3.1)", () => {
  it("only gives a group to a teacher of its level", () => {
    const result = assignTeachers(
      build(
        [grp("g1", LEVEL_B, [MON_9("a")])],
        [tch("t1", [LEVEL_A]), tch("t2", [LEVEL_B])],
      ),
    );
    expect(teacherOf(result, "g1")).toBe("t2");
  });

  it("never gives a teacher two groups at the same time", () => {
    const result = assignTeachers(
      build(
        [grp("g1", LEVEL_A, [MON_9("a")]), grp("g2", LEVEL_A, [MON_9("b")])],
        [tch("t1", [LEVEL_A])],
      ),
    );
    expect(result.final.unassignedGroups).toBe(1);
    const missing = result.unassigned[0];
    expect(missing.reason).toBe("NO_TEACHER_FITS");
    expect(missing.teachers[0].reasons).toEqual([
      expect.objectContaining({
        code: "TEACHING_IN_DRAFT",
        params: expect.objectContaining({ weekday: 1, locked: "no" }),
      }),
    ]);
  });

  it("treats weekly unavailability as hard and one-off as a warning", () => {
    const result = assignTeachers(
      build(
        [grp("g1", LEVEL_A, [MON_9("a")])],
        [tch("t1", [LEVEL_A]), tch("t2", [LEVEL_A])],
        {
          context: {
            availability: [
              {
                id: "weekly",
                teacherId: "t1",
                kind: "WEEKLY_UNAVAILABLE",
                weekday: 1,
                date: null,
                startMinute: h(8),
                endMinute: h(12),
              },
              {
                id: "oneoff",
                teacherId: "t2",
                kind: "DATE_UNAVAILABLE",
                weekday: null,
                date: "2026-10-19",
                startMinute: null,
                endMinute: null,
              },
            ],
          },
        },
      ),
    );
    expect(teacherOf(result, "g1")).toBe("t2");
    expect(result.warnings[0].conflicts.map((c) => [c.type, c.dates])).toEqual([
      ["TEACHER_UNAVAILABLE_ON_DATE", ["2026-10-19"]],
    ]);
  });

  it("keeps a teacher within their weekly maximum", () => {
    const result = assignTeachers(
      build(
        [
          grp("g1", LEVEL_A, [MON_9("a")]),
          grp("g2", LEVEL_A, [lt("b", 2, h(9), h(10, 30))]),
        ],
        [tch("t1", [LEVEL_A], { maxMinutesPerWeek: 120 })],
      ),
    );
    expect(result.final.unassignedGroups).toBe(1);
    expect(result.unassigned[0].teachers[0].reasons).toEqual([
      {
        code: "OVER_MAX_HOURS",
        params: { currentMinutes: 90, withMinutes: 180, maxMinutes: 120 },
        refs: { teacherId: "t1" },
      },
    ]);
    expect(result.unassigned[0].suggestions).toEqual([
      { kind: "ONLY_MAX_HOURS", teacherId: "t1" },
    ]);
  });

  it("is blocked by lessons in the fixed context, other terms included", () => {
    const input = build(
      [grp("g1", LEVEL_A, [MON_9("a")]), grp("other", LEVEL_A, [])],
      [tch("t1", [LEVEL_A]), tch("t2", [LEVEL_A])],
      {
        context: {
          lessons: [
            lesson("busy", {
              groupId: "other",
              teacherId: "t1",
              roomId: null,
              startsAt: new Date("2026-10-19T07:00:00Z"),
              endsAt: new Date("2026-10-19T08:00:00Z"),
            }),
          ],
        },
      },
    );
    const result = assignTeachers(input);
    expect(teacherOf(result, "g1")).toBe("t2");
    const options = draftTeacherOptions(
      { ...input, assignments: result.assignments },
      "g1",
    )!;
    expect(options.find((o) => o.teacherId === "t1")).toMatchObject({
      section: "BUSY",
      reasons: [
        {
          code: "BUSY",
          params: expect.objectContaining({
            dateCount: 1,
            firstDate: "2026-10-19",
          }),
        },
      ],
    });
  });
});

describe("objective (§3.3)", () => {
  it("evens out the workload", () => {
    const groups = [1, 2, 3, 4].map((d) =>
      grp(`g${d}`, LEVEL_A, [lt(`x${d}`, d, h(9), h(10, 30))]),
    );
    const result = assignTeachers(
      build(groups, [tch("t1", [LEVEL_A]), tch("t2", [LEVEL_A])]),
    );
    expect(result.final.perTeacher.map((p) => p.minutes)).toEqual([180, 180]);
    expect(result.final.workloadRange).toBe(0);
    expect(result.final.workloadPenalty).toBe(2 * 180 ** 2);
  });

  it("staffs as many groups as possible before evening out", () => {
    // t1 teaches both levels, t2 only A: B must go to t1.
    const result = assignTeachers(
      build(
        [
          grp("a1", LEVEL_A, [MON_9("a")]),
          grp("b1", LEVEL_B, [lt("b", 2, h(9), h(10, 30))]),
          grp("a2", LEVEL_A, [lt("c", 2, h(9), h(10, 30))]),
        ],
        [tch("t1", [LEVEL_A, LEVEL_B]), tch("t2", [LEVEL_A])],
      ),
    );
    expect(result.final.unassignedGroups).toBe(0);
    expect(teacherOf(result, "b1")).toBe("t1");
    expect(teacherOf(result, "a2")).toBe("t2");
  });

  it("repairs with an ejection chain", () => {
    // g1 (A or B teacher) is placed first on t1 by id; g2 can only go to t1.
    const result = assignTeachers(
      build(
        [grp("g1", LEVEL_A, [MON_9("a")]), grp("g2", LEVEL_B, [MON_9("b")])],
        [tch("t1", [LEVEL_A, LEVEL_B]), tch("t2", [LEVEL_A])],
      ),
    );
    expect(teacherOf(result, "g1")).toBe("t2");
    expect(teacherOf(result, "g2")).toBe("t1");
  });
});

describe("explanations (§4.5)", () => {
  it("says nobody teaches the level", () => {
    const result = assignTeachers(
      build([grp("g1", LEVEL_B, [MON_9("a")])], [tch("t1", [LEVEL_A])]),
    );
    expect(result.unassigned).toEqual([
      expect.objectContaining({
        groupId: "g1",
        reason: "LEVEL_UNCOVERED",
        params: { level: "B1", teachers: 0 },
        teachers: [],
        suggestions: [{ kind: "NOT_TEACHING_LEVEL", teacherId: "t1" }],
      }),
    ]);
  });

  it("lists every reason per teacher, archived teachers last", () => {
    const result = assignTeachers(
      build(
        [grp("g1", LEVEL_A, [MON_9("a")]), grp("g0", LEVEL_A, [MON_9("b")])],
        [
          tch("t1", [LEVEL_A], { name: "Zoe" }),
          tch("t2", [LEVEL_A], { name: "Adam", archived: true }),
        ],
        {
          context: {
            availability: [
              {
                id: "w",
                teacherId: "t2",
                kind: "WEEKLY_UNAVAILABLE",
                weekday: 1,
                date: null,
                startMinute: h(8),
                endMinute: h(10),
              },
            ],
          },
        },
      ),
    );
    const missing = result.unassigned.find((u) => u.groupId === "g1")!;
    expect(
      missing.teachers.map((t) => [t.teacherId, t.reasons.map((r) => r.code)]),
    ).toEqual([
      ["t1", ["TEACHING_IN_DRAFT"]],
      ["t2", ["ARCHIVED", "UNAVAILABLE_WEEKLY"]],
    ]);
    expect(missing.teachers[1].reasons[1].params).toEqual({
      weekday: 1,
      time: "08:00–10:00",
      allDay: "no",
    });
  });

  it("suggests a swap around a locked assignment", () => {
    // g2 is locked on t1; t2 could take g2 so g1 (level B, only t1) fits.
    const result = assignTeachers(
      build(
        [grp("g1", LEVEL_B, [MON_9("a")]), grp("g2", LEVEL_A, [MON_9("b")])],
        [tch("t1", [LEVEL_A, LEVEL_B]), tch("t2", [LEVEL_A])],
        {
          assignments: [
            { groupId: "g2", teacherId: "t1", locked: true, origin: "MANUAL" },
          ],
        },
      ),
    );
    expect(teacherOf(result, "g2")).toBe("t1");
    expect(result.unassigned[0]).toMatchObject({
      groupId: "g1",
      reason: "NO_TEACHER_FITS",
      suggestions: [
        {
          kind: "SWAP",
          teacherId: "t1",
          otherGroupId: "g2",
          otherTeacherId: "t2",
          otherLocked: true,
        },
        // t2 is free but doesn't teach B1.
        { kind: "NOT_TEACHING_LEVEL", teacherId: "t2" },
      ],
    });
  });

  it("explains a group the admin set to no teacher", () => {
    const result = assignTeachers(
      build([grp("g1", LEVEL_A, [MON_9("a")])], [tch("t1", [LEVEL_A])], {
        assignments: [
          { groupId: "g1", teacherId: null, locked: true, origin: "MANUAL" },
        ],
      }),
    );
    expect(result.unassigned[0]).toMatchObject({
      reason: "REMOVED_BY_ADMIN",
      suggestions: [],
    });
  });
});

describe("locks and drafts (§5.3, §5.4)", () => {
  it("keeps locked assignments even when they break a rule", () => {
    const result = assignTeachers(
      build([grp("g1", LEVEL_B, [MON_9("a")])], [tch("t1", [LEVEL_A])], {
        assignments: [
          { groupId: "g1", teacherId: "t1", locked: true, origin: "MANUAL" },
        ],
      }),
    );
    expect(result.assignments).toEqual([
      {
        groupId: "g1",
        teacherId: "t1",
        locked: true,
        origin: "MANUAL",
        fallback: false,
        minutes: 90,
      },
    ]);
    expect(result.warnings[0].conflicts.map((c) => c.type)).toEqual([
      "TEACHER_LEVEL_NOT_TAUGHT",
    ]);
  });

  it("drops locked assignments of groups no longer included", () => {
    const locked = {
      groupId: "g1",
      teacherId: "t1",
      locked: true,
      origin: "MANUAL" as const,
    };
    const result = assignTeachers(
      build(
        [grp("g1", LEVEL_A, [MON_9("a")], { skipped: true })],
        [tch("t1", [LEVEL_A])],
        { assignments: [locked] },
      ),
    );
    expect(result.assignments).toEqual([]);
    expect(result.removedAssignments).toEqual([locked]);
  });

  it("evaluates a draft as stored without changing it", () => {
    const input = build(
      [grp("g1", LEVEL_A, [MON_9("a")]), grp("g2", LEVEL_A, [MON_9("b")])],
      [tch("t1", [LEVEL_A]), tch("t2", [LEVEL_A])],
      {
        assignments: [
          {
            groupId: "g1",
            teacherId: "t1",
            locked: false,
            origin: "GENERATED",
          },
        ],
      },
    );
    const result = evaluateDraft(input);
    expect(result.assignments.map((a) => [a.groupId, a.teacherId])).toEqual([
      ["g1", "t1"],
      ["g2", null],
    ]);
    expect(
      draftTeacherOptions(input, "g2")!.map((o) => [o.teacherId, o.section]),
    ).toEqual([
      ["t1", "BUSY"],
      ["t2", "AVAILABLE"],
    ]);
  });

  it("fingerprints the input regardless of order and assignments", () => {
    const a = build(
      [grp("g1", LEVEL_A, [MON_9("a")]), grp("g2", LEVEL_A, [MON_9("b")])],
      [tch("t1", [LEVEL_A]), tch("t2", [LEVEL_A])],
    );
    const b = {
      ...a,
      groups: [...a.groups].reverse(),
      teachers: [...a.teachers].reverse(),
      assignments: [
        {
          groupId: "g1",
          teacherId: "t1",
          locked: true,
          origin: "MANUAL" as const,
        },
      ],
    };
    expect(fingerprintPayload(b)).toBe(fingerprintPayload(a));
    const c = { ...a, teachers: [tch("t1", [LEVEL_B]), a.teachers[1]] };
    expect(fingerprintPayload(c)).not.toBe(fingerprintPayload(a));
  });
});

describe("published terms (§2.4, §5.2)", () => {
  const D = "2026-10-26";
  const times = { g1: MON_9("a"), g2: lt("b", 2, h(9), h(10, 30)) };

  it("FILL keeps groups with live slots and staffs the others from D", () => {
    const result = assignTeachers(
      build(
        [grp("g1", LEVEL_A, [times.g1]), grp("g2", LEVEL_A, [times.g2])],
        [tch("t1", [LEVEL_A]), tch("t2", [LEVEL_A])],
        {
          mode: "FILL",
          effectiveFrom: D,
          slots: [liveSlot("s1", "g1", "t1", times.g1)],
        },
      ),
    );
    const status = Object.fromEntries(
      result.readiness.groups.map((g) => [g.groupId, g.status]),
    );
    expect(status).toEqual({ g1: "KEPT", g2: "READY" });
    expect(result.assignments.map((a) => a.groupId)).toEqual(["g2"]);
    expect(
      result.readiness.groups.find((g) => g.groupId === "g2")!.times[0],
    ).toMatchObject({ validFrom: D, validUntil: null });
    // t1 already has g1's 90 minutes, so g2 goes to t2.
    expect(teacherOf(result, "g2")).toBe("t2");
  });

  it("REPLAN_FROM keeps current teachers when nothing changed", () => {
    const result = assignTeachers(
      build(
        [grp("g1", LEVEL_A, [times.g1]), grp("g2", LEVEL_A, [times.g2])],
        [tch("t1", [LEVEL_A]), tch("t2", [LEVEL_A])],
        {
          mode: "REPLAN_FROM",
          effectiveFrom: D,
          // Both with t1: uneven, but the term is not rebalanced (Q2).
          slots: [
            liveSlot("s1", "g1", "t1", times.g1),
            liveSlot("s2", "g2", "t1", times.g2),
          ],
        },
      ),
    );
    expect(result.assignments.map((a) => [a.teacherId, a.origin])).toEqual([
      ["t1", "IMPORTED"],
      ["t1", "IMPORTED"],
    ]);
    expect(result.final.changedTeachers).toBe(0);
    expect(result.readiness.groups[0].times[0]).toMatchObject({
      key: "slot:s1",
      liveSlotId: "s1",
      validFrom: D,
    });
  });

  it("REPLAN_FROM replaces a current teacher who no longer fits", () => {
    const result = assignTeachers(
      build(
        [grp("g1", LEVEL_B, [times.g1])],
        [tch("t1", [LEVEL_A]), tch("t2", [LEVEL_B])],
        {
          mode: "REPLAN_FROM",
          effectiveFrom: D,
          slots: [liveSlot("s1", "g1", "t1", times.g1)],
        },
      ),
    );
    expect(result.assignments[0]).toMatchObject({
      teacherId: "t2",
      origin: "GENERATED",
      fallback: false,
    });
    expect(result.final).toMatchObject({
      keptIneligible: 0,
      changedTeachers: 1,
    });
    // Construction keeps it; the improvement moves it (§4.2 step 5).
    expect(result.construction.keptIneligible).toBe(1);
  });

  it("REPLAN_FROM keeps an ineligible current teacher when nobody fits", () => {
    const result = assignTeachers(
      build([grp("g1", LEVEL_B, [times.g1])], [tch("t1", [LEVEL_A])], {
        mode: "REPLAN_FROM",
        effectiveFrom: D,
        slots: [liveSlot("s1", "g1", "t1", times.g1)],
      }),
    );
    expect(result.assignments[0]).toMatchObject({
      teacherId: "t1",
      origin: "IMPORTED",
      fallback: true,
    });
    expect(result.final).toMatchObject({
      unassignedGroups: 0,
      keptIneligible: 1,
      changedTeachers: 0,
    });
    expect(result.warnings[0].conflicts.map((c) => c.type)).toContain(
      "TEACHER_LEVEL_NOT_TAUGHT",
    );
  });

  it("REPLAN_FROM never compares a group with its own lessons", () => {
    const slot = liveSlot("s1", "g1", "t1", times.g1);
    const result = assignTeachers(
      build([grp("g1", LEVEL_A, [times.g1])], [tch("t1", [LEVEL_A])], {
        mode: "REPLAN_FROM",
        effectiveFrom: D,
        slots: [slot],
        context: {
          lessons: [
            lesson("l1", {
              timetableSlotId: "s1",
              occurrenceDate: "2026-10-26",
              teacherId: "t1",
              roomId: slot.roomId,
              startsAt: new Date("2026-10-26T08:00:00Z"),
              endsAt: new Date("2026-10-26T09:30:00Z"),
            }),
          ],
        },
      }),
    );
    expect(result.assignments[0]).toMatchObject({
      teacherId: "t1",
      fallback: false,
    });
    expect(result.warnings).toEqual([]);
  });

  it("REPLAN_FROM never takes a running group's teacher away", () => {
    // Ejecting gA would give t1 both gB and gC (2 groups instead of 1).
    const a1 = lt("a1", 1, h(9), h(10, 30));
    const a2 = lt("a2", 3, h(9), h(10, 30));
    const result = assignTeachers(
      build(
        [
          grp("gA", LEVEL_A, [a1, a2]),
          grp("gB", LEVEL_A, [lt("b1", 1, h(9), h(10, 30))]),
          grp("gC", LEVEL_A, [lt("c1", 3, h(9), h(10, 30))]),
        ],
        [tch("t1", [LEVEL_A])],
        {
          mode: "REPLAN_FROM",
          effectiveFrom: "2026-10-19",
          slots: [
            liveSlot("sA1", "gA", "t1", a1),
            liveSlot("sA2", "gA", "t1", a2),
          ],
        },
      ),
    );
    expect(teacherOf(result, "gA")).toBe("t1");
    expect(teacherOf(result, "gB")).toBeNull();
    expect(teacherOf(result, "gC")).toBeNull();
  });

  it("marks mixed teachers", () => {
    const result = assignTeachers(
      build(
        [grp("g1", LEVEL_A, [times.g1, times.g2])],
        [tch("t1", [LEVEL_A]), tch("t2", [LEVEL_A])],
        {
          mode: "REPLAN_FROM",
          effectiveFrom: D,
          slots: [
            liveSlot("s1", "g1", "t1", times.g1),
            liveSlot("s2", "g1", "t2", times.g2),
          ],
        },
      ),
    );
    expect(result.readiness.groups[0]).toMatchObject({
      currentTeacherId: null,
      mixedTeachers: true,
    });
    expect(result.warnings[0].notices).toEqual([
      { code: "MIXED_TEACHERS", params: {} },
    ]);
  });
});
