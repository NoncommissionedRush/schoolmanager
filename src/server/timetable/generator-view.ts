// View model of the "Assign teachers" page (docs/design/timetable-generator.md
// §6): pure functions that turn the generator service's readiness and draft
// into the rows the screens render. No Prisma, no React.

import type {
  DraftAssignmentInput,
  DraftConflict,
  GroupNoticeCode,
  GroupReadiness,
  GroupWarnings,
  Readiness,
  ReadinessStatus,
  TeacherWarning,
  UnassignedGroup,
  WorkloadSummary,
} from "@/server/scheduling/generator";

/** `TimetableDraft.summary` as the service stores it. */
export type DraftSummary = {
  construction: WorkloadSummary;
  final: WorkloadSummary;
  previousRange?: { minMinutes: number; maxMinutes: number } | null;
};

/** `TimetableDraft.warnings` as the service stores it. */
export type DraftWarnings = {
  groups: GroupWarnings[];
  teachers: TeacherWarning[];
  removedAssignments: DraftAssignmentInput[];
  fallback: string[];
};

const EMPTY_WARNINGS: DraftWarnings = {
  groups: [],
  teachers: [],
  removedAssignments: [],
  fallback: [],
};

/**
 * The draft's JSON columns, typed. A draft that never ran has the column
 * defaults (`[]`, null).
 */
export function readDraftJson(draft: {
  summary: unknown;
  unassigned: unknown;
  warnings: unknown;
}): {
  summary: DraftSummary | null;
  unassigned: UnassignedGroup[];
  warnings: DraftWarnings;
} {
  const summary =
    draft.summary &&
    typeof draft.summary === "object" &&
    "final" in draft.summary
      ? (draft.summary as DraftSummary)
      : null;
  const unassigned = Array.isArray(draft.unassigned)
    ? (draft.unassigned as UnassignedGroup[])
    : [];
  const warnings =
    draft.warnings &&
    typeof draft.warnings === "object" &&
    !Array.isArray(draft.warnings)
      ? { ...EMPTY_WARNINGS, ...(draft.warnings as Partial<DraftWarnings>) }
      : EMPTY_WARNINGS;
  return { summary, unassigned, warnings };
}

/** Statuses that need the admin's attention (§6.2). */
const ATTENTION: ReadonlySet<ReadinessStatus> = new Set([
  "NO_LESSON_TIMES",
  "NO_ROOM",
  "TIMES_CLASH",
  "LEVEL_UNCOVERED",
]);

export const needsAttention = (status: ReadinessStatus) =>
  ATTENTION.has(status);

/**
 * A group the run assigns: ready, or with a level nobody teaches (it ends
 * up without a teacher and is listed with the reason).
 */
export const isIncludedStatus = (status: ReadinessStatus) =>
  status === "READY" || status === "LEVEL_UNCOVERED";

/** Tab ① status line: "{ready} ready · {attention} need attention". */
export function readinessCounts(readiness: Readiness) {
  let ready = 0;
  let attention = 0;
  let skipped = 0;
  let kept = 0;
  for (const group of readiness.groups) {
    if (group.status === "READY") ready++;
    else if (group.status === "SKIPPED") skipped++;
    else if (group.status === "KEPT") kept++;
    if (ATTENTION.has(group.status)) attention++;
  }
  const included = readiness.groups.filter((g) => isIncludedStatus(g.status));
  return {
    ready,
    attention,
    skipped,
    kept,
    included: included.length,
    /** Groups not ready and therefore skipped by a run. */
    notReady: readiness.groups.filter(
      (g) => ATTENTION.has(g.status) && !isIncludedStatus(g.status),
    ).length,
    lessons: included.reduce((sum, g) => sum + g.times.length, 0),
    minutes: included.reduce((sum, g) => sum + g.minutes, 0),
  };
}

/** Minutes → hours for display, at most two decimals ("7.5"). */
export const hours = (minutes: number) =>
  Math.round((minutes / 60) * 100) / 100;

export type DraftRow = {
  groupId: string;
  teacherId: string | null;
  locked: boolean;
  origin: DraftAssignmentInput["origin"];
  /** Present when the group has no teacher: reasons and suggestions. */
  unassigned: UnassignedGroup | null;
  conflicts: DraftConflict[];
  notices: { code: GroupNoticeCode; params: Record<string, unknown> }[];
  /** Teacher of the live slots (published modes, editor slots in REPLACE). */
  currentTeacherId: string | null;
  /** The draft gives the group another teacher than it has now. */
  changed: boolean;
  /** Weekly minutes of the group's times. */
  minutes: number;
};

/**
 * One row per draft assignment (§6.6): groups without a teacher first, then
 * by group name.
 */
export function draftRows(
  assignments: readonly DraftAssignmentInput[],
  unassigned: readonly UnassignedGroup[],
  warnings: DraftWarnings,
  readiness: readonly GroupReadiness[],
  groupName: (groupId: string) => string,
): DraftRow[] {
  const missing = new Map(unassigned.map((u) => [u.groupId, u]));
  const byGroup = new Map(warnings.groups.map((w) => [w.groupId, w]));
  const ready = new Map(readiness.map((g) => [g.groupId, g]));
  const rows = assignments.map((a): DraftRow => {
    const group = ready.get(a.groupId);
    const current = group?.currentTeacherId ?? null;
    return {
      groupId: a.groupId,
      teacherId: a.teacherId,
      locked: a.locked,
      origin: a.origin,
      unassigned: a.teacherId ? null : (missing.get(a.groupId) ?? null),
      conflicts: byGroup.get(a.groupId)?.conflicts ?? [],
      notices: (byGroup.get(a.groupId)?.notices ?? []) as DraftRow["notices"],
      currentTeacherId: current,
      changed: current !== null && a.teacherId !== current,
      minutes: group?.minutes ?? 0,
    };
  });
  return rows.sort(
    (a, b) =>
      Number(a.teacherId !== null) - Number(b.teacherId !== null) ||
      groupName(a.groupId).localeCompare(groupName(b.groupId)),
  );
}

export type WorkloadRow = {
  teacherId: string;
  minutes: number;
  groups: number;
  groupIds: string[];
  weekdays: number[];
  maxMinutes: number | null;
};

/**
 * By teacher view (§6.8): every active teacher, busiest first; teachers
 * with nothing are listed too (they may be the fix for a group without one).
 */
export function workloadRows(
  rows: readonly DraftRow[],
  readiness: readonly GroupReadiness[],
  teachers: readonly {
    id: string;
    archived: boolean;
    maxMinutesPerWeek: number | null;
  }[],
  name: (teacherId: string) => string,
): WorkloadRow[] {
  const times = new Map(readiness.map((g) => [g.groupId, g.times]));
  const out = new Map<string, WorkloadRow>();
  for (const teacher of teachers) {
    if (teacher.archived) continue;
    out.set(teacher.id, {
      teacherId: teacher.id,
      minutes: 0,
      groups: 0,
      groupIds: [],
      weekdays: [],
      maxMinutes: teacher.maxMinutesPerWeek,
    });
  }
  for (const row of rows) {
    if (!row.teacherId) continue;
    const entry = out.get(row.teacherId);
    if (!entry) continue;
    entry.minutes += row.minutes;
    entry.groups += 1;
    entry.groupIds.push(row.groupId);
    for (const time of times.get(row.groupId) ?? []) {
      if (!entry.weekdays.includes(time.weekday))
        entry.weekdays.push(time.weekday);
    }
  }
  for (const entry of out.values()) entry.weekdays.sort((a, b) => a - b);
  return [...out.values()].sort(
    (a, b) =>
      b.minutes - a.minutes ||
      name(a.teacherId).localeCompare(name(b.teacherId)),
  );
}

/** Compare to current (§6.10): which groups change teacher, and who is affected. */
export function compareSummary(
  rows: readonly DraftRow[],
  members: (groupId: string) => number,
) {
  const changed = rows.filter((row) => row.changed);
  const teachers = new Set<string>();
  for (const row of changed) {
    if (row.currentTeacherId) teachers.add(row.currentTeacherId);
    if (row.teacherId) teachers.add(row.teacherId);
  }
  return {
    changed: changed.length,
    teachers: teachers.size,
    students: changed.reduce((sum, row) => sum + members(row.groupId), 0),
    hasCurrent: rows.some((row) => row.currentTeacherId !== null),
  };
}

/** Workload range card (§6.5): least–most busy among teachers with groups. */
export function workloadRange(rows: readonly WorkloadRow[]) {
  const busy = rows.filter((row) => row.minutes > 0);
  if (busy.length === 0) return null;
  const minutes = busy.map((row) => row.minutes);
  return {
    min: Math.min(...minutes),
    max: Math.max(...minutes),
    average: minutes.reduce((a, b) => a + b, 0) / busy.length,
  };
}

/**
 * Keys of the issues the admin ticked in the publish dialog, restricted to
 * the ones the preview asked for (stale ticks are dropped).
 */
export function acknowledgedKeys(
  issues: readonly { key: string }[],
  ticked: ReadonlySet<string>,
): string[] {
  return issues.filter((issue) => ticked.has(issue.key)).map((i) => i.key);
}
