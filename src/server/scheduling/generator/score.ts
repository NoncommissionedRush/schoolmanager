// The objective (generator.md §3.3), kept incrementally while the engine
// moves groups between teachers, and recomputed from scratch for checks.

import type { Eligibility } from "./eligibility";
import type { Prepared } from "./readiness";
import type { Objective, TeacherWorkload, WorkloadSummary } from "./types";

/** Lexicographic comparison: negative when `a` is better (smaller). */
export function compareObjectives(a: Objective, b: Objective): number {
  return (
    a.unassignedGroups - b.unassignedGroups ||
    a.unassignedMinutes - b.unassignedMinutes ||
    a.keptIneligible - b.keptIneligible ||
    a.changedTeachers - b.changedTeachers ||
    a.workloadPenalty - b.workloadPenalty ||
    a.workloadRange - b.workloadRange
  );
}

/** One change recorded so a tentative move can be undone. */
type JournalEntry = { g: number; teacher: number; fallback: boolean };

/**
 * Who teaches which included group. Indices are those of `Eligibility`:
 * groups by id, teachers by id; -1 = no teacher.
 */
export class AssignmentState {
  readonly teacherOf: Int32Array;
  readonly fallback: Uint8Array;
  readonly locked: Uint8Array;
  /** REPLAN_FROM: the live teacher per group, -1 when none. */
  readonly current: Int32Array;
  readonly minutes: Float64Array;
  readonly groupsOf: Set<number>[];
  private readonly inPool: Uint8Array;
  private readonly countChanges: boolean;
  private unassignedGroups = 0;
  private unassignedMinutes = 0;
  private keptIneligible = 0;
  private changedTeachers = 0;
  private penalty = 0;
  private journal: JournalEntry[] = [];

  constructor(
    readonly e: Eligibility,
    prepared: Prepared,
  ) {
    const G = e.groups.length;
    const T = e.teachers.length;
    this.teacherOf = new Int32Array(G).fill(-1);
    this.fallback = new Uint8Array(G);
    this.locked = new Uint8Array(G);
    this.current = new Int32Array(G).fill(-1);
    this.minutes = new Float64Array(T);
    this.groupsOf = Array.from({ length: T }, () => new Set<number>());
    this.inPool = new Uint8Array(T);
    for (const t of e.pool) this.inPool[t] = 1;
    this.countChanges = prepared.input.mode === "REPLAN_FROM";
    const index = new Map(e.teachers.map((t, i) => [t.id, i]));
    e.teachers.forEach((teacher, t) => {
      this.minutes[t] = prepared.baselineMinutes.get(teacher.id) ?? 0;
    });
    e.groups.forEach((group, g) => {
      const cur = group.currentTeacherId;
      if (this.countChanges && cur !== null && index.has(cur)) {
        this.current[g] = index.get(cur)!;
        this.changedTeachers++;
      }
      this.unassignedGroups++;
      this.unassignedMinutes += e.minutes[g];
    });
    for (const t of e.pool) this.penalty += this.minutes[t] ** 2;
  }

  /** Gives group `g` to teacher `t` (or nobody, -1), journaled. */
  set(g: number, t: number, fallback = false) {
    const before = this.teacherOf[g];
    this.journal.push({ g, teacher: before, fallback: !!this.fallback[g] });
    this.apply(g, t, fallback);
  }

  private apply(g: number, t: number, fallback: boolean) {
    const w = this.e.minutes[g];
    const before = this.teacherOf[g];
    if (before >= 0) {
      this.move(before, -w);
      this.groupsOf[before].delete(g);
    } else {
      this.unassignedGroups--;
      this.unassignedMinutes -= w;
    }
    if (this.fallback[g]) this.keptIneligible--;
    if (this.current[g] >= 0 && before !== this.current[g]) {
      this.changedTeachers--;
    }
    this.teacherOf[g] = t;
    this.fallback[g] = fallback && t >= 0 ? 1 : 0;
    if (t >= 0) {
      this.move(t, w);
      this.groupsOf[t].add(g);
    } else {
      this.unassignedGroups++;
      this.unassignedMinutes += w;
    }
    if (this.fallback[g]) this.keptIneligible++;
    if (this.current[g] >= 0 && t !== this.current[g]) this.changedTeachers++;
  }

  private move(t: number, delta: number) {
    if (this.inPool[t]) {
      const m = this.minutes[t];
      this.penalty += (m + delta) ** 2 - m ** 2;
    }
    this.minutes[t] += delta;
  }

  /** Position to `rollback` to. */
  mark(): number {
    return this.journal.length;
  }

  rollback(mark: number) {
    while (this.journal.length > mark) {
      const entry = this.journal.pop()!;
      this.apply(entry.g, entry.teacher, entry.fallback);
    }
  }

  /** Forget the journal (after a move is accepted for good). */
  commit() {
    this.journal = [];
  }

  /**
   * Rules 4–5 for giving `g` to `t`, ignoring the groups in `ignore`
   * (they are about to leave `t`).
   */
  isFree(g: number, t: number, ignore: readonly number[] = []): boolean {
    const overlaps = this.e.overlaps[g];
    let freed = 0;
    for (const h of this.groupsOf[t]) {
      if (h === g) continue;
      if (ignore.includes(h)) {
        freed += this.e.minutes[h];
        continue;
      }
      if (overlaps.has(h)) return false;
    }
    const max = this.e.teachers[t].maxMinutesPerWeek;
    const own = this.teacherOf[g] === t ? this.e.minutes[g] : 0;
    return (
      max === null || this.minutes[t] - freed - own + this.e.minutes[g] <= max
    );
  }

  objective(): Objective {
    let min = Infinity;
    let max = -Infinity;
    for (const t of this.e.pool) {
      const m = this.minutes[t];
      if (m < min) min = m;
      if (m > max) max = m;
    }
    return {
      unassignedGroups: this.unassignedGroups,
      unassignedMinutes: this.unassignedMinutes,
      keptIneligible: this.keptIneligible,
      changedTeachers: this.changedTeachers,
      workloadPenalty: this.penalty,
      workloadRange: this.e.pool.length > 0 ? max - min : 0,
    };
  }
}

/** The objective recomputed from scratch (property 8). */
export function recomputeObjective(
  state: AssignmentState,
  prepared: Prepared,
): Objective {
  const { e } = state;
  const minutes = e.teachers.map(
    (t) => prepared.baselineMinutes.get(t.id) ?? 0,
  );
  let unassignedGroups = 0;
  let unassignedMinutes = 0;
  let keptIneligible = 0;
  let changedTeachers = 0;
  e.groups.forEach((_, g) => {
    const t = state.teacherOf[g];
    if (t < 0) {
      unassignedGroups++;
      unassignedMinutes += e.minutes[g];
    } else {
      minutes[t] += e.minutes[g];
    }
    if (state.fallback[g]) keptIneligible++;
    if (state.current[g] >= 0 && state.current[g] !== t) changedTeachers++;
  });
  const pool = e.pool.map((t) => minutes[t]);
  return {
    unassignedGroups,
    unassignedMinutes,
    keptIneligible,
    changedTeachers,
    workloadPenalty: pool.reduce((n, m) => n + m * m, 0),
    workloadRange: pool.length > 0 ? Math.max(...pool) - Math.min(...pool) : 0,
  };
}

/** What the admin sees (§3.3): range, average, per teacher. */
export function summarize(
  state: AssignmentState,
  prepared: Prepared,
): WorkloadSummary {
  const { e } = state;
  const objective = state.objective();
  const shown = new Set<number>(e.pool);
  e.groups.forEach((_, g) => {
    if (state.teacherOf[g] >= 0) shown.add(state.teacherOf[g]);
  });
  const perTeacher: TeacherWorkload[] = [...shown]
    .sort((a, b) => a - b)
    .map((t) => {
      const teacher = e.teachers[t];
      const days = new Set(prepared.baselineDays.get(teacher.id) ?? []);
      for (const g of state.groupsOf[t]) {
        for (const time of e.groups[g].times) days.add(time.weekday);
      }
      return {
        teacherId: teacher.id,
        minutes: state.minutes[t],
        groups: state.groupsOf[t].size,
        teachingDays: days.size,
        maxMinutes: teacher.maxMinutesPerWeek,
      };
    });
  const pool = e.pool.map((t) => state.minutes[t]);
  return {
    ...objective,
    minMinutes: pool.length > 0 ? Math.min(...pool) : 0,
    maxMinutes: pool.length > 0 ? Math.max(...pool) : 0,
    averageMinutes:
      pool.length > 0
        ? Math.round(pool.reduce((n, m) => n + m, 0) / pool.length)
        : 0,
    perTeacher,
  };
}
