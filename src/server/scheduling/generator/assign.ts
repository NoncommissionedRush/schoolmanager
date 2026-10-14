// Construction with repair, then improvement (generator.md §4.2 steps 4–5).
// The descent adds a fourth move to the three of §4.2, eject (below): the
// exhaustive oracle showed relocate, swap and insert alone stuck on about
// 10 % of small instances.
// Deterministic: groups and teachers are visited by index (= by id), ties go
// to the lower teacher id, and the budget is counted in moves evaluated.

import { type AssignmentState, compareObjectives } from "./score";
import type { GeneratorProgress, Objective, StoppedBy } from "./types";

export const DEFAULT_MAX_ITERATIONS = 200_000;
export const DEFAULT_TIME_LIMIT_MS = 10_000;
/** Ejection chains (§4.2 step 4). */
const REPAIR_DEPTH = 3;
const REPAIR_NODES = 2_000;
/** Progress is yielded about this often (§4.6). */
const YIELD_EVERY = 2_000;

export type AssignOptions = {
  maxIterations: number;
  timeLimitMs: number;
  clock?: () => number;
};

export type AssignOutcome = {
  iterations: number;
  stoppedBy: StoppedBy;
  /** Groups construction never reached because the time cap fired. */
  timeLimited: Set<number>;
};

/**
 * Gives `g` the free eligible teacher with the best objective; with
 * `depth` > 0, ejects overlapping unlocked groups from a teacher and
 * re-places them recursively. Leaves the state unchanged on failure.
 */
function insert(
  state: AssignmentState,
  g: number,
  depth: number,
  budget: { nodes: number },
  moving: Set<number>,
): boolean {
  const { e } = state;
  let best = -1;
  let bestObjective = null;
  const mark = state.mark();
  for (const t of e.eligible[g]) {
    if (!state.isFree(g, t)) continue;
    state.set(g, t);
    const objective = state.objective();
    state.rollback(mark);
    if (!bestObjective || compareObjectives(objective, bestObjective) < 0) {
      best = t;
      bestObjective = objective;
    }
  }
  if (best >= 0) {
    state.set(g, best);
    return true;
  }
  if (depth === 0) return false;

  moving.add(g);
  for (const t of e.eligible[g]) {
    if (budget.nodes-- <= 0) break;
    const blockers = [...state.groupsOf[t]]
      .filter((h) => e.overlaps[g].has(h))
      .sort((a, b) => a - b);
    if (blockers.length === 0) continue; // not free by rule 5 alone
    if (blockers.some((h) => state.locked[h] || moving.has(h))) continue;
    if (!state.isFree(g, t, blockers)) continue;
    const before = state.mark();
    for (const h of blockers) state.set(h, -1);
    state.set(g, t);
    let ok = true;
    for (const h of blockers) {
      if (!insert(state, h, depth - 1, budget, moving)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      moving.delete(g);
      return true;
    }
    state.rollback(before);
  }
  moving.delete(g);
  state.rollback(mark);
  return false;
}

/** Construction order (§4.2 step 4): fewest eligible, most minutes, id. */
function constructionOrder(state: AssignmentState): number[] {
  const { e } = state;
  return e.groups
    .map((_, g) => g)
    .filter((g) => !state.locked[g] && state.teacherOf[g] < 0)
    .sort(
      (a, b) =>
        e.eligible[a].length - e.eligible[b].length ||
        e.minutes[b] - e.minutes[a] ||
        a - b,
    );
}

/**
 * Steps 4–5 on a state that already holds the locked (and in REPLAN_FROM
 * the imported) assignments. Yields progress; returns how it stopped.
 */
export function* assign(
  state: AssignmentState,
  options: AssignOptions,
): Generator<GeneratorProgress, AssignOutcome> {
  const { e } = state;
  const total = e.groups.length;
  const assigned = () => total - state.objective().unassignedGroups;
  const startedAt = options.clock?.();
  const overTime = () =>
    options.clock !== undefined &&
    options.clock() - startedAt! > options.timeLimitMs;
  const timeLimited = new Set<number>();
  let iterations = 0;
  let stoppedBy: StoppedBy = "converged";
  // Every placement and every move evaluated counts, so a run stopped by
  // the clock replays exactly with `maxIterations` = its count (§4.4).
  const step = (): "go" | StoppedBy => {
    if (iterations >= options.maxIterations) return "iterations";
    if (iterations % 64 === 0 && overTime()) return "time";
    iterations++;
    return "go";
  };
  const progress = (phase: GeneratorProgress["phase"]): GeneratorProgress => ({
    phase,
    assigned: assigned(),
    total,
    iterations,
  });

  // Construction.
  yield progress("assigning");
  const order = constructionOrder(state);
  for (let k = 0; k < order.length; k++) {
    const s = step();
    if (s !== "go") {
      for (const g of order.slice(k)) timeLimited.add(g);
      state.commit();
      return { iterations, stoppedBy: s, timeLimited };
    }
    insert(state, order[k], REPAIR_DEPTH, { nodes: REPAIR_NODES }, new Set());
    state.commit();
  }

  // Improvement: first-improvement descent over relocate, swap, insert and
  // eject.
  const movable = e.groups.map((_, g) => g).filter((g) => !state.locked[g]);
  yield progress("balancing");

  outer: for (;;) {
    let moved = false;
    // Relocate.
    for (const g of movable) {
      const from = state.teacherOf[g];
      if (from < 0) continue;
      for (const t of e.eligible[g]) {
        if (t === from) continue;
        const s = step();
        if (s !== "go") {
          stoppedBy = s;
          break outer;
        }
        if (iterations % YIELD_EVERY === 0) yield progress("balancing");
        if (!state.isFree(g, t)) continue;
        const before = state.objective();
        const mark = state.mark();
        state.set(g, t);
        if (compareObjectives(state.objective(), before) < 0) {
          state.commit();
          moved = true;
          break;
        }
        state.rollback(mark);
      }
    }
    // Swap.
    for (let i = 0; i < movable.length; i++) {
      const g = movable[i];
      for (let j = i + 1; j < movable.length; j++) {
        const h = movable[j];
        const a = state.teacherOf[g];
        const b = state.teacherOf[h];
        if (a < 0 || b < 0 || a === b) continue;
        const s = step();
        if (s !== "go") {
          stoppedBy = s;
          break outer;
        }
        if (iterations % YIELD_EVERY === 0) yield progress("balancing");
        if (!e.eligible[g].includes(b) || !e.eligible[h].includes(a)) continue;
        if (!state.isFree(g, b, [h]) || !state.isFree(h, a, [g])) continue;
        const before = state.objective();
        const mark = state.mark();
        state.set(g, -1);
        state.set(h, a);
        state.set(g, b);
        if (compareObjectives(state.objective(), before) < 0) {
          state.commit();
          moved = true;
        } else {
          state.rollback(mark);
        }
      }
    }
    // Insert with repair.
    for (const g of movable) {
      if (state.teacherOf[g] >= 0 || e.eligible[g].length === 0) continue;
      const s = step();
      if (s !== "go") {
        stoppedBy = s;
        break outer;
      }
      if (iterations % YIELD_EVERY === 0) yield progress("balancing");
      const before = state.objective();
      const mark = state.mark();
      if (
        insert(state, g, REPAIR_DEPTH, { nodes: REPAIR_NODES }, new Set()) &&
        compareObjectives(state.objective(), before) < 0
      ) {
        state.commit();
        moved = true;
      } else {
        state.rollback(mark);
      }
    }
    // Eject: take one group out and re-insert every group without a
    // teacher, the ejected one last. Reaches "one out, two in", which the
    // chains of insert can't (they only eject groups that fit elsewhere).
    // A group with live slots never loses its teacher this way: the
    // objective counts it like a new group, but its lessons would end (§5.2).
    const running = (g: number) =>
      e.groups[g].times.some((t) => t.liveSlotId !== null);
    const waiting = movable.filter(
      (g) => state.teacherOf[g] < 0 && e.eligible[g].length > 0,
    );
    if (waiting.length > 0) {
      for (const g of movable) {
        if (state.teacherOf[g] < 0) continue;
        const s = step();
        if (s !== "go") {
          stoppedBy = s;
          break outer;
        }
        if (iterations % YIELD_EVERY === 0) yield progress("balancing");
        const before = state.objective();
        const mark = state.mark();
        state.set(g, -1);
        // Most constrained first, then smallest first (fits more groups
        // under a weekly maximum or along a chain of overlaps).
        const bySize = (a: number, b: number) =>
          e.minutes[a] - e.minutes[b] ||
          e.eligible[a].length - e.eligible[b].length ||
          a - b;
        const others = constructionOrder(state).filter((x) => x !== g);
        let best: { objective: Objective; order: number[] } | null = null;
        for (const order of [others, [...others].sort(bySize)]) {
          const tried = state.mark();
          for (const other of order) {
            insert(
              state,
              other,
              REPAIR_DEPTH,
              { nodes: REPAIR_NODES },
              new Set(),
            );
          }
          insert(state, g, REPAIR_DEPTH, { nodes: REPAIR_NODES }, new Set());
          const objective = state.objective();
          if (!best || compareObjectives(objective, best.objective) < 0) {
            best = { objective, order };
          }
          state.rollback(tried);
        }
        for (const other of best!.order) {
          insert(
            state,
            other,
            REPAIR_DEPTH,
            { nodes: REPAIR_NODES },
            new Set(),
          );
        }
        insert(state, g, REPAIR_DEPTH, { nodes: REPAIR_NODES }, new Set());
        const dropsRunning = running(g) && state.teacherOf[g] < 0;
        if (!dropsRunning && compareObjectives(state.objective(), before) < 0) {
          state.commit();
          moved = true;
        } else {
          state.rollback(mark);
        }
      }
    }
    if (!moved) break;
  }
  state.commit();
  return { iterations, stoppedBy, timeLimited };
}
