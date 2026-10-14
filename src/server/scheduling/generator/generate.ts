// The generator's entry points (generator.md §4.2, §4.6): a run
// (`assignTeachers` / the step-wise `assignTeachersSteps`), the evaluation
// of a draft as it stands (`evaluateDraft`, for review, edits and Check
// draft), readiness without a run, and the input fingerprint (§5.5).

import type { ConflictType } from "../conflict-types";
import { buildCalendar, checkSlot } from "../conflicts";
import {
  assign,
  type AssignOutcome,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TIME_LIMIT_MS,
} from "./assign";
import { computeEligibility, type Eligibility } from "./eligibility";
import {
  explainUnassigned,
  teacherOptions as pickerOptions,
  type TeacherOption,
} from "./explain";
import {
  normalizeInput,
  type Prepared,
  prepare,
  readinessChecks,
  timeAsSlot,
  toDraftConflict,
} from "./readiness";
import { AssignmentState, summarize } from "./score";
import type {
  AssignmentOrigin,
  DraftAssignmentInput,
  DraftAssignmentResult,
  DraftConflict,
  GeneratorInput,
  GeneratorOptions,
  GeneratorProgress,
  GeneratorResult,
  GroupReasonCode,
  GroupWarnings,
  Readiness,
  TeacherWarning,
  WorkloadSummary,
} from "./types";

/**
 * Conflicts the generator never produces (§3.2). `OVER_MAX_HOURS` is the
 * engine's own aggregate check, not a `checkSlot` conflict.
 */
export const GENERATOR_HARD_CONFLICTS: readonly (
  ConflictType | "OVER_MAX_HOURS"
)[] = [
  "TEACHER_DOUBLE_BOOKED",
  "TEACHER_UNAVAILABLE_WEEKLY",
  "TEACHER_LEVEL_NOT_TAUGHT",
  "OVER_MAX_HOURS",
];
const HARD = new Set<string>(GENERATOR_HARD_CONFLICTS);

/** Everything a run or an evaluation works on. */
export type Analysis = {
  prepared: Prepared;
  eligibility: Eligibility;
  state: AssignmentState;
  /** Given origins of seeded assignments, by group index. */
  origins: Map<number, AssignmentOrigin>;
  removedAssignments: DraftAssignmentInput[];
};

/**
 * Step 4's start: locked assignments as given, then (REPLAN_FROM) each
 * other group with live slots starts with its current teacher, as a
 * fallback when that teacher is no longer eligible. `all` seeds every
 * stored assignment as it is (evaluation).
 */
function analyse(input: GeneratorInput, all: boolean): Analysis {
  const prepared = prepare(input);
  const eligibility = computeEligibility(prepared);
  const state = new AssignmentState(eligibility, prepared);
  const groupIndex = new Map(eligibility.groups.map((g, i) => [g.groupId, i]));
  const teacherIndex = new Map(eligibility.teachers.map((t, i) => [t.id, i]));
  const origins = new Map<number, AssignmentOrigin>();
  const removedAssignments: DraftAssignmentInput[] = [];
  const seeded = new Set<number>();

  for (const a of prepared.input.assignments) {
    const g = groupIndex.get(a.groupId);
    if (g === undefined) {
      if (a.locked) removedAssignments.push(a);
      continue;
    }
    if (!a.locked && !all) continue;
    const t = a.teacherId === null ? -1 : (teacherIndex.get(a.teacherId) ?? -1);
    const kept =
      t >= 0 && state.current[g] === t && !eligibility.eligible[g].includes(t);
    if (t >= 0) state.set(g, t, all && kept);
    state.locked[g] = a.locked ? 1 : 0;
    origins.set(g, a.origin);
    seeded.add(g);
  }
  if (!all && prepared.input.mode === "REPLAN_FROM") {
    eligibility.groups.forEach((_, g) => {
      const t = state.current[g];
      if (seeded.has(g) || t < 0) return;
      const fits = eligibility.eligible[g].includes(t) && state.isFree(g, t);
      state.set(g, t, !fits);
    });
  }
  state.commit();
  return { prepared, eligibility, state, origins, removedAssignments };
}

type Verified = {
  warnings: GroupWarnings[];
  teacherWarnings: TeacherWarning[];
};

/**
 * Step 6: one calendar with every draft time and its teacher; `checkSlot`
 * on each and the weekly minutes re-summed. A generator-hard conflict on a
 * generated assignment is an engine bug: the group loses its teacher
 * (`INTERNAL_CHECK_FAILED`). Everything else is kept as a warning.
 */
function verify(
  analysis: Analysis,
  generated: (g: number) => boolean,
  causes: Map<number, GroupReasonCode>,
): Verified {
  const { prepared, eligibility: e, state } = analysis;
  for (let round = 0; ; round++) {
    const termId = prepared.term.id;
    const draftSlots = e.groups.flatMap((group, g) =>
      state.teacherOf[g] < 0
        ? []
        : group.times.map((time) =>
            timeAsSlot(time, termId, e.teachers[state.teacherOf[g]].id),
          ),
    );
    const calendar = buildCalendar({
      ...prepared.fixedContext,
      slots: [...prepared.fixedContext.slots, ...draftSlots],
    });
    const failed = new Set<number>();
    const warnings: GroupWarnings[] = [];
    e.groups.forEach((group, g) => {
      const t = state.teacherOf[g];
      let conflicts: DraftConflict[];
      if (t < 0) {
        conflicts = group.timeWarnings;
      } else {
        conflicts = group.times.flatMap((time) =>
          checkSlot(calendar, timeAsSlot(time, termId, e.teachers[t].id)).map(
            (c) => toDraftConflict(group.groupId, time, c),
          ),
        );
        if (generated(g) && conflicts.some((c) => HARD.has(c.type))) {
          failed.add(g);
        }
      }
      const notices = group.mixedTeachers
        ? [{ code: "MIXED_TEACHERS" as const, params: {} }]
        : [];
      if (conflicts.length > 0 || notices.length > 0) {
        warnings.push({ groupId: group.groupId, conflicts, notices });
      }
    });
    const teacherWarnings: TeacherWarning[] = [];
    e.teachers.forEach((teacher, t) => {
      const max = teacher.maxMinutesPerWeek;
      if (max === null || state.groupsOf[t].size === 0) return;
      if (state.minutes[t] <= max) return;
      const mine = [...state.groupsOf[t]]
        .filter(generated)
        .sort((a, b) => b - a);
      let minutes = state.minutes[t];
      for (const g of mine) {
        if (minutes <= max) break;
        failed.add(g);
        minutes -= e.minutes[g];
      }
      teacherWarnings.push({
        code: "OVER_MAX_HOURS",
        teacherId: teacher.id,
        minutes: state.minutes[t],
        maxMinutes: max,
        key: `maxHours:${teacher.id}`,
      });
    });
    if (failed.size === 0 || round >= 3) return { warnings, teacherWarnings };
    for (const g of failed) {
      state.set(g, -1);
      causes.set(g, "INTERNAL_CHECK_FAILED");
    }
    state.commit();
  }
}

function originOf(
  analysis: Analysis,
  g: number,
  generated: boolean,
): AssignmentOrigin {
  const { state, origins } = analysis;
  if (!generated && origins.has(g)) return origins.get(g)!;
  if (state.current[g] >= 0 && state.current[g] === state.teacherOf[g]) {
    return "IMPORTED";
  }
  return origins.get(g) ?? "GENERATED";
}

function finish(
  analysis: Analysis,
  construction: WorkloadSummary,
  outcome: AssignOutcome,
  causes: Map<number, GroupReasonCode>,
  generated: (g: number) => boolean,
): GeneratorResult {
  const { prepared, eligibility: e, state } = analysis;
  const verified = verify(analysis, generated, causes);
  for (const g of outcome.timeLimited) {
    if (state.teacherOf[g] < 0 && !causes.has(g)) causes.set(g, "TIME_LIMIT");
  }
  const assignments: DraftAssignmentResult[] = e.groups.map((group, g) => {
    const t = state.teacherOf[g];
    return {
      groupId: group.groupId,
      teacherId: t >= 0 ? e.teachers[t].id : null,
      locked: !!state.locked[g],
      origin: originOf(analysis, g, generated(g)),
      fallback: !!state.fallback[g],
      minutes: e.minutes[g],
    };
  });
  return {
    termId: prepared.term.id,
    mode: prepared.input.mode,
    startDate: prepared.startDate,
    readiness: readinessOf(prepared, e),
    assignments,
    removedAssignments: analysis.removedAssignments,
    unassigned: explainUnassigned(prepared, state, causes),
    ...verified,
    construction,
    final: summarize(state, prepared),
    iterations: outcome.iterations,
    stoppedBy: outcome.stoppedBy,
  };
}

function readinessOf(prepared: Prepared, e: Eligibility): Readiness {
  return {
    termId: prepared.term.id,
    mode: prepared.input.mode,
    startDate: prepared.startDate,
    groups: prepared.groups,
    checks: readinessChecks(prepared, e),
  };
}

/**
 * A run, step by step: yields progress about every 2 000 moves so the
 * service can serve other requests and check for cancellation (§4.6). The
 * returned result equals `assignTeachers(input)`.
 */
export function* assignTeachersSteps(
  input: GeneratorInput,
  options: GeneratorOptions = {},
): Generator<GeneratorProgress, GeneratorResult> {
  yield { phase: "checking", assigned: 0, total: 0, iterations: 0 };
  const analysis = analyse(input, false);
  const { state } = analysis;
  // Locked and kept (fallback) assignments are not the engine's choice.
  const generated = (g: number) => !state.locked[g] && !state.fallback[g];

  let construction: WorkloadSummary | null = null;
  const steps = assign(state, {
    maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    timeLimitMs: input.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS,
    clock: options.clock,
  });
  let next = steps.next();
  while (!next.done) {
    if (next.value.phase === "balancing" && construction === null) {
      construction = summarize(state, analysis.prepared);
    }
    yield next.value;
    next = steps.next();
  }
  construction ??= summarize(state, analysis.prepared);
  return finish(analysis, construction, next.value, new Map(), generated);
}

/** A whole run (§4.2). Deterministic: same input, same result. */
export function assignTeachers(
  input: GeneratorInput,
  options: GeneratorOptions = {},
): GeneratorResult {
  const steps = assignTeachersSteps(input, options);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/**
 * The draft as stored, re-checked against current data without changing
 * any assignment (Check draft, §5.3; also review and apply).
 */
export function evaluateDraft(input: GeneratorInput): GeneratorResult {
  const analysis = analyse(input, true);
  const summary = summarize(analysis.state, analysis.prepared);
  return finish(
    analysis,
    summary,
    { iterations: 0, stoppedBy: "converged", timeLimited: new Set() },
    new Map(),
    () => false,
  );
}

/** Readiness of every group and the readiness checks, without a run (§2.5). */
export function checkGeneratorReadiness(input: GeneratorInput): Readiness {
  const prepared = prepare(input);
  return readinessOf(prepared, computeEligibility(prepared));
}

/**
 * The picker sections for one group of the draft (§5.3), with the draft's
 * assignments as stored. Null when the group is not in the draft.
 */
export function draftTeacherOptions(
  input: GeneratorInput,
  groupId: string,
): TeacherOption[] | null {
  const analysis = analyse(input, true);
  const g = analysis.eligibility.groups.findIndex((x) => x.groupId === groupId);
  if (g < 0) return null;
  return pickerOptions(analysis.prepared, analysis.state, g);
}

/**
 * Canonical JSON of everything a run reads except the draft's own
 * assignments and the budget (§5.5); the service hashes it.
 */
export function fingerprintPayload(input: GeneratorInput): string {
  const normalized = normalizeInput(input);
  return JSON.stringify({
    termId: normalized.termId,
    mode: normalized.mode,
    effectiveFrom: normalized.effectiveFrom,
    context: normalized.context,
    groups: normalized.groups,
    teachers: normalized.teachers,
    levels: normalized.levels,
  });
}

/** For tests: the analysis a run starts from. */
export const analyseForTest = analyse;
