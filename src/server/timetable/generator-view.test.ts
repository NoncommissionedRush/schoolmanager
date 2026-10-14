import { describe, expect, it } from "vitest";

import type {
  GroupReadiness,
  Readiness,
  ReadinessStatus,
  UnassignedGroup,
} from "@/server/scheduling/generator";

import {
  acknowledgedKeys,
  compareSummary,
  draftRows,
  hours,
  readDraftJson,
  readinessCounts,
  workloadRange,
  workloadRows,
} from "./generator-view";

function group(
  groupId: string,
  status: ReadinessStatus,
  extra: Partial<GroupReadiness> = {},
): GroupReadiness {
  return {
    groupId,
    levelId: "A1",
    status,
    times: [
      {
        key: `lt:${groupId}`,
        groupId,
        weekday: 2,
        startMinute: 17 * 60,
        endMinute: 18 * 60 + 30,
        roomId: "r",
        validFrom: null,
        validUntil: null,
        liveSlotId: null,
        lessonTimeId: groupId,
      },
    ],
    minutes: 90,
    currentTeacherId: null,
    mixedTeachers: false,
    clashes: [],
    timeWarnings: [],
    ...extra,
  };
}

const NAMES: Record<string, string> = {
  g1: "B1 Evening",
  g2: "A1 Morning",
  g3: "C2 Proficiency",
  t1: "Ana",
  t2: "Eva",
  t3: "Tomas",
};
const name = (id: string) => NAMES[id] ?? id;

describe("readDraftJson", () => {
  it("reads a draft that never ran as empty", () => {
    expect(
      readDraftJson({ summary: null, unassigned: [], warnings: [] }),
    ).toEqual({
      summary: null,
      unassigned: [],
      warnings: {
        groups: [],
        teachers: [],
        removedAssignments: [],
        fallback: [],
      },
    });
  });

  it("keeps the stored shapes", () => {
    const json = readDraftJson({
      summary: { construction: {}, final: { minMinutes: 1 } },
      unassigned: [{ groupId: "g3" }],
      warnings: { groups: [], teachers: [], fallback: ["g1"] },
    });
    expect(json.summary?.final).toEqual({ minMinutes: 1 });
    expect(json.unassigned).toHaveLength(1);
    expect(json.warnings.fallback).toEqual(["g1"]);
    expect(json.warnings.removedAssignments).toEqual([]);
  });
});

describe("readinessCounts", () => {
  it("counts ready, attention, skipped and what a run includes", () => {
    const readiness = {
      groups: [
        group("g1", "READY"),
        group("g2", "NO_LESSON_TIMES", { times: [], minutes: 0 }),
        group("g3", "LEVEL_UNCOVERED"),
        group("g4", "SKIPPED"),
        group("g5", "TIMES_CLASH"),
      ],
    } as unknown as Readiness;
    expect(readinessCounts(readiness)).toEqual({
      ready: 1,
      attention: 3,
      skipped: 1,
      kept: 0,
      included: 2,
      notReady: 2,
      lessons: 2,
      minutes: 180,
    });
  });
});

describe("draftRows", () => {
  const unassigned = [
    { groupId: "g3", levelId: "C2", reason: "LEVEL_UNCOVERED" },
  ] as unknown as UnassignedGroup[];
  const readiness = [
    group("g1", "READY", { currentTeacherId: "t2" }),
    group("g2", "READY", { minutes: 60 }),
    group("g3", "LEVEL_UNCOVERED"),
  ];
  const rows = draftRows(
    [
      { groupId: "g1", teacherId: "t1", locked: true, origin: "MANUAL" },
      { groupId: "g2", teacherId: "t1", locked: false, origin: "GENERATED" },
      { groupId: "g3", teacherId: null, locked: false, origin: "GENERATED" },
    ],
    unassigned,
    {
      groups: [
        {
          groupId: "g2",
          conflicts: [],
          notices: [{ code: "MIXED_TEACHERS", params: {} }],
        },
      ],
      teachers: [],
      removedAssignments: [],
      fallback: [],
    },
    readiness,
    name,
  );

  it("puts groups without a teacher first, then sorts by name", () => {
    expect(rows.map((row) => row.groupId)).toEqual(["g3", "g2", "g1"]);
    expect(rows[0].unassigned?.reason).toBe("LEVEL_UNCOVERED");
    expect(rows[1].notices).toHaveLength(1);
  });

  it("marks a group whose teacher changes", () => {
    expect(rows.find((row) => row.groupId === "g1")).toMatchObject({
      currentTeacherId: "t2",
      changed: true,
      minutes: 90,
    });
    expect(rows.find((row) => row.groupId === "g2")?.changed).toBe(false);
    expect(compareSummary(rows, () => 6)).toEqual({
      changed: 1,
      teachers: 2,
      students: 6,
      hasCurrent: true,
    });
  });

  it("sums workload per active teacher, busiest first, idle ones included", () => {
    const workload = workloadRows(
      rows,
      readiness,
      [
        { id: "t1", archived: false, maxMinutesPerWeek: 480 },
        { id: "t2", archived: false, maxMinutesPerWeek: null },
        { id: "t3", archived: true, maxMinutesPerWeek: null },
      ],
      name,
    );
    expect(workload).toEqual([
      {
        teacherId: "t1",
        minutes: 150,
        groups: 2,
        groupIds: ["g2", "g1"],
        weekdays: [2],
        maxMinutes: 480,
      },
      {
        teacherId: "t2",
        minutes: 0,
        groups: 0,
        groupIds: [],
        weekdays: [],
        maxMinutes: null,
      },
    ]);
    expect(workloadRange(workload)).toEqual({
      min: 150,
      max: 150,
      average: 150,
    });
    expect(workloadRange(workload.slice(1))).toBeNull();
  });
});

describe("helpers", () => {
  it("formats hours and keeps only acknowledgements the preview asked for", () => {
    expect(hours(450)).toBe(7.5);
    expect(hours(100)).toBe(1.67);
    expect(
      acknowledgedKeys([{ key: "a" }, { key: "b" }], new Set(["b", "stale"])),
    ).toEqual(["b"]);
  });
});
