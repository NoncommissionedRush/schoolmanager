import { describe, expect, it } from "vitest";

import { buildCalendar, checkSlot, UNASSIGNED_TEACHER } from "../conflicts";
import {
  build,
  grp,
  h,
  LEVEL_A,
  LEVEL_B,
  liveSlot,
  lt,
  tch,
} from "../testing/generator-fixtures";
import { plantedSlots, realisticGeneratorData } from "../testing/generator";
import { prng, PROPERTY_TEST_TIMEOUT_MS } from "../testing/realistic";
import type { AvailabilityRule } from "../types";
import {
  assignTeachers,
  assignTeachersSteps,
  compareObjectives,
  GENERATOR_HARD_CONFLICTS,
  type GeneratorInput,
  type GeneratorResult,
  type Objective,
} from ".";
import { analyseForTest } from "./generate";
import { timeAsSlot } from "./readiness";
import { recomputeObjective } from "./score";

// Properties of docs/architecture/generator.md §6.3, on fixed seeds.

const SEEDS = [1, 2, 3, 4, 5];
const HARD = new Set<string>(GENERATOR_HARD_CONFLICTS);

/** A random small school: ≤ 8 groups, ≤ 4 teachers, two levels. */
function smallInstance(seed: number): GeneratorInput {
  const r = prng(seed);
  const groups = Array.from({ length: r.int(2, 8) }, (_, i) => {
    const days = r.shuffle([1, 2, 3]).slice(0, r.int(1, 2));
    return grp(
      `g${i}`,
      r.pick([LEVEL_A, LEVEL_B]),
      days.map((weekday, k) => {
        const start = h(r.int(9, 11), r.pick([0, 30]));
        return lt(`g${i}-${k}`, weekday, start, start + r.pick([60, 90]));
      }),
    );
  });
  const availability: AvailabilityRule[] = [];
  const teachers = Array.from({ length: r.int(1, 4) }, (_, i) => {
    const id = `t${i}`;
    if (r.next() < 0.3) {
      availability.push({
        id: `w-${id}`,
        teacherId: id,
        kind: "WEEKLY_UNAVAILABLE",
        weekday: r.int(1, 3),
        date: null,
        startMinute: h(r.int(8, 11)),
        endMinute: h(r.int(12, 13)),
      });
    }
    return tch(id, r.pick([[LEVEL_A], [LEVEL_B], [LEVEL_A, LEVEL_B]]), {
      maxMinutesPerWeek: r.next() < 0.3 ? r.pick([90, 120, 180, 240]) : null,
    });
  });
  return build(groups, teachers, { context: { availability } });
}

/** The lexicographic optimum by exhaustive search (the CP-SAT gate, §4.1). */
function oracle(input: GeneratorInput): Objective {
  const { eligibility: e, state } = analyseForTest(input, false);
  const G = e.groups.length;
  let best: Objective | null = null;
  const go = (g: number) => {
    if (g === G) {
      const objective = state.objective();
      if (!best || compareObjectives(objective, best) < 0) best = objective;
      return;
    }
    for (const t of e.eligible[g]) {
      if (!state.isFree(g, t)) continue;
      const mark = state.mark();
      state.set(g, t);
      go(g + 1);
      state.rollback(mark);
    }
    go(g + 1);
  };
  go(0);
  return best!;
}

/**
 * Property 1 with an independent calendar: the context plus every draft
 * time with its teacher (REPLACE inputs).
 */
function hardViolations(input: GeneratorInput, result: GeneratorResult) {
  const teacherLevels = input.teachers.flatMap((t) =>
    t.levelIds.map((levelId) => ({ teacherId: t.id, levelId })),
  );
  const timesOf = new Map(result.readiness.groups.map((g) => [g.groupId, g]));
  const draft = result.assignments.flatMap((a) =>
    a.teacherId === null
      ? []
      : timesOf
          .get(a.groupId)!
          .times.map((t) => timeAsSlot(t, input.termId, a.teacherId!)),
  );
  const calendar = buildCalendar({
    ...input.context,
    slots: [
      ...input.context.slots.filter((s) => s.termId !== input.termId),
      ...draft,
    ],
    teacherLevels,
  });
  const out: string[] = [];
  for (const slot of draft) {
    const a = result.assignments.find((x) => x.groupId === slot.groupId)!;
    if (a.locked || a.fallback) continue;
    for (const c of checkSlot(calendar, slot)) {
      if (HARD.has(c.type)) out.push(`${slot.groupId}:${c.type}`);
    }
  }
  const minutes = new Map<string, number>();
  for (const s of draft) {
    minutes.set(
      s.teacherId,
      (minutes.get(s.teacherId) ?? 0) + s.endMinute - s.startMinute,
    );
  }
  for (const t of input.teachers) {
    const m = minutes.get(t.id) ?? 0;
    if (t.maxMinutesPerWeek !== null && m > t.maxMinutesPerWeek) {
      out.push(`${t.id}:OVER_MAX_HOURS`);
    }
  }
  for (const a of result.assignments) {
    if (a.teacherId === null || a.locked) continue;
    const level = input.groups.find((g) => g.id === a.groupId)!.levelId;
    const teacher = input.teachers.find((t) => t.id === a.teacherId)!;
    if (!teacher.levelIds.includes(level)) out.push(`${a.groupId}:LEVEL`);
  }
  return out;
}

const shuffled = (input: GeneratorInput, seed: number): GeneratorInput => {
  const r = prng(seed);
  const c = input.context;
  return {
    ...input,
    context: {
      ...c,
      groups: r.shuffle(c.groups).map((g) => ({
        ...g,
        studentIds: r.shuffle(g.studentIds),
      })),
      teachers: r.shuffle(c.teachers),
      rooms: r.shuffle(c.rooms),
      students: r.shuffle(c.students),
      availability: r.shuffle(c.availability),
      holidays: r.shuffle(c.holidays),
      slots: r.shuffle(c.slots),
    },
    groups: r
      .shuffle(input.groups)
      .map((g) => ({ ...g, lessonTimes: r.shuffle(g.lessonTimes) })),
    teachers: r
      .shuffle(input.teachers)
      .map((t) => ({ ...t, levelIds: r.shuffle(t.levelIds) })),
    levels: r.shuffle(input.levels),
  };
};

/** Realistic school, published: planted live slots, some partial, from D. */
function publishedInput(seed: number): GeneratorInput {
  const data = realisticGeneratorData(seed);
  const r = prng(seed + 99);
  const slots = plantedSlots(data).map((s) => {
    const x = r.next();
    if (x < 0.15) return { ...s, validUntil: "2026-12-04" };
    if (x < 0.3) return { ...s, validFrom: "2026-11-09" };
    return s;
  });
  return {
    ...data.input,
    mode: "REPLAN_FROM",
    effectiveFrom: "2026-10-26",
    context: { ...data.input.context, slots },
  };
}

describe("generator properties (§6.3)", () => {
  it(
    "1. never produces a generator-hard conflict",
    () => {
      for (const seed of SEEDS) {
        for (const variant of ["normal", "tight"] as const) {
          const { input } = realisticGeneratorData(seed, variant);
          expect(hardViolations(input, assignTeachers(input))).toEqual([]);
        }
      }
      for (let seed = 1; seed <= 100; seed++) {
        const input = smallInstance(seed);
        expect(
          hardViolations(input, assignTeachers(input)),
          `seed ${seed}`,
        ).toEqual([]);
      }
    },
    PROPERTY_TEST_TIMEOUT_MS * 2,
  );

  it(
    "2. overlap graph = checker (partial live slots, holidays, DST)",
    () => {
      for (const seed of [1, 2]) {
        const input = publishedInput(seed);
        input.context = {
          ...input.context,
          teachers: [...input.context.teachers, { id: "probe", name: "Probe" }],
        };
        const { prepared, eligibility: e } = analyseForTest(input, false);
        let compared = 0;
        let overlapping = 0;
        e.groups.forEach((g, i) => {
          e.groups.forEach((other, j) => {
            if (i === j) return;
            const sameDay = g.times.some((a) =>
              other.times.some((b) => a.weekday === b.weekday),
            );
            if (!sameDay) return;
            const calendar = buildCalendar({
              ...prepared.fixedContext,
              slots: [
                ...prepared.fixedContext.slots,
                ...other.times.map((t) => timeAsSlot(t, input.termId, "probe")),
              ],
            });
            const otherIds = new Set(other.times.map((t) => `draft:${t.key}`));
            const clash = g.times.some((t) =>
              checkSlot(calendar, timeAsSlot(t, input.termId, "probe")).some(
                (c) =>
                  c.type === "TEACHER_DOUBLE_BOOKED" &&
                  otherIds.has(c.refs.counterpart?.id ?? ""),
              ),
            );
            compared++;
            if (clash) overlapping++;
            expect(e.overlaps[i].has(j), `${g.groupId}/${other.groupId}`).toBe(
              clash,
            );
          });
        });
        expect(compared).toBeGreaterThan(100);
        expect(overlapping).toBeGreaterThan(0);
      }
    },
    PROPERTY_TEST_TIMEOUT_MS * 2,
  );

  it(
    "3. eligibility = checker; UNASSIGNED_TEACHER = a teacher with nothing",
    () => {
      const input = publishedInput(3);
      input.context = {
        ...input.context,
        teachers: [...input.context.teachers, { id: "fresh", name: "Fresh" }],
      };
      const { prepared, eligibility: e } = analyseForTest(input, false);
      const calendar = prepared.fixedCalendar;
      e.groups.forEach((group, g) => {
        e.teachers.forEach((teacher, t) => {
          if (teacher.archived || !teacher.levelIds.includes(group.levelId)) {
            return;
          }
          const free = group.times.every(
            (time) =>
              !checkSlot(calendar, timeAsSlot(time, input.termId, teacher.id))
                .map((c) => c.type)
                .some(
                  (type) =>
                    type === "TEACHER_DOUBLE_BOOKED" ||
                    type === "TEACHER_UNAVAILABLE_WEEKLY",
                ),
          );
          expect(e.eligible[g].includes(t)).toBe(free);
        });
        for (const time of group.times) {
          const none = checkSlot(
            calendar,
            timeAsSlot(time, input.termId, UNASSIGNED_TEACHER),
          );
          const fresh = checkSlot(
            calendar,
            timeAsSlot(time, input.termId, "fresh"),
          );
          expect(none.filter((c) => c.type.startsWith("TEACHER_"))).toEqual([]);
          expect(none).toEqual(fresh);
        }
      });
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it(
    "4. is deterministic, order-independent and replayable",
    () => {
      for (const seed of [1, 2]) {
        const { input } = realisticGeneratorData(seed, "tight");
        const result = assignTeachers(input);
        expect(assignTeachers(input)).toEqual(result);
        expect(assignTeachers(shuffled(input, seed))).toEqual(result);

        const steps = assignTeachersSteps(input);
        let yields = 0;
        let next = steps.next();
        while (!next.done) {
          yields++;
          next = steps.next();
        }
        expect(yields).toBeGreaterThan(2);
        expect(next.value).toEqual(result);

        // Capped by iterations, and by the clock: replayable either way.
        const k = Math.floor(result.iterations / 2);
        const capped = assignTeachers({ ...input, maxIterations: k });
        expect(capped.stoppedBy).toBe("iterations");
        expect(capped.iterations).toBe(k);
        let calls = 0;
        const timed = assignTeachers(
          { ...input, timeLimitMs: 1 },
          { clock: () => (calls++ < 40 ? 0 : 1000) },
        );
        expect(timed.stoppedBy).toBe("time");
        const replay = assignTeachers({
          ...input,
          maxIterations: timed.iterations,
        });
        expect(replay.assignments).toEqual(timed.assignments);
      }
    },
    PROPERTY_TEST_TIMEOUT_MS * 2,
  );

  it(
    "5. keeps locked assignments; everything locked gives the input",
    () => {
      for (const seed of SEEDS) {
        const { input } = realisticGeneratorData(seed);
        const first = assignTeachers(input);
        const r = prng(seed);
        const locked = first.assignments
          .filter(() => r.next() < 0.5)
          .map((a) => ({
            groupId: a.groupId,
            // Some locked to someone else, as an admin might.
            teacherId: r.next() < 0.2 ? r.pick(input.teachers).id : a.teacherId,
            locked: true,
            origin: "MANUAL" as const,
          }));
        const result = assignTeachers({ ...input, assignments: locked });
        for (const l of locked) {
          expect(
            result.assignments.find((a) => a.groupId === l.groupId),
          ).toMatchObject({ teacherId: l.teacherId, locked: true });
        }
        const all = first.assignments.map((a) => ({
          groupId: a.groupId,
          teacherId: a.teacherId,
          locked: true,
          origin: a.origin,
        }));
        const frozen = assignTeachers({ ...input, assignments: all });
        expect(
          frozen.assignments.map(({ groupId, teacherId, locked, origin }) => ({
            groupId,
            teacherId,
            locked,
            origin,
          })),
        ).toEqual(all);
        expect(frozen.iterations).toBe(0);
      }
    },
    PROPERTY_TEST_TIMEOUT_MS * 2,
  );

  it(
    "10. never leaves a running group without a teacher (REPLAN_FROM)",
    () => {
      const check = (input: GeneratorInput, label: string) => {
        const result = assignTeachers(input);
        for (const group of result.readiness.groups) {
          if (group.currentTeacherId === null) continue;
          const a = result.assignments.find((x) => x.groupId === group.groupId);
          if (!a) continue;
          expect(a.teacherId, `${label} ${group.groupId}`).not.toBeNull();
        }
      };
      for (const seed of SEEDS) check(publishedInput(seed), `seed ${seed}`);
      // Small schools where some groups already run, sometimes with a
      // teacher who no longer fits: eject would like to drop them.
      let running = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const input = smallInstance(2000 + seed);
        const r = prng(seed);
        const slots = input.groups.flatMap((g) => {
          if (r.next() < 0.4) return [];
          running++;
          const teacher = r.pick(input.teachers).id;
          return g.lessonTimes.map((t) =>
            liveSlot(`live-${t.id}`, g.id, teacher, t),
          );
        });
        check(
          {
            ...input,
            mode: "REPLAN_FROM",
            effectiveFrom: "2026-10-19",
            context: { ...input.context, slots },
          },
          `small ${seed}`,
        );
      }
      expect(running).toBeGreaterThan(300);
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it("6. accounts for every included group once", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const input = smallInstance(seed);
      input.groups = input.groups.map((g, i) =>
        i === 0 ? { ...g, skipped: true } : g,
      );
      const result = assignTeachers(input);
      const included = result.readiness.groups
        .filter((g) => g.status === "READY" || g.status === "LEVEL_UNCOVERED")
        .map((g) => g.groupId);
      expect(result.assignments.map((a) => a.groupId)).toEqual(included);
      const without = result.assignments.filter((a) => a.teacherId === null);
      expect(without.map((a) => a.groupId)).toEqual(
        result.unassigned.map((u) => u.groupId),
      );
      expect(result.final.unassignedGroups).toBe(without.length);
      expect(included).not.toContain("g0");
    }
  });

  it(
    "7. is maximal, and its reasons agree with a recount",
    () => {
      let unassigned = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const input = smallInstance(seed);
        const result = assignTeachers(input);
        const { eligibility: e, state } = analyseForTest(
          { ...input, assignments: result.assignments },
          true,
        );
        for (const u of result.unassigned) {
          unassigned++;
          const g = e.groups.findIndex((x) => x.groupId === u.groupId);
          for (const t of e.eligible[g]) {
            expect(state.isFree(g, t), `seed ${seed}`).toBe(false);
            const blockers = [...state.groupsOf[t]].filter((x) =>
              e.overlaps[g].has(x),
            );
            if (blockers.length !== 1 || !state.isFree(g, t, blockers)) {
              continue;
            }
            const [b] = blockers;
            for (const other of e.eligible[b]) {
              if (other === t) continue;
              const mark = state.mark();
              state.set(g, t);
              state.set(b, -1);
              const movable = state.isFree(b, other);
              state.rollback(mark);
              expect(movable, `seed ${seed} repair`).toBe(false);
            }
          }
          // Recount the reasons with the checker.
          const calendar = buildCalendar({
            ...input.context,
            slots: result.assignments.flatMap((a) =>
              a.teacherId === null
                ? []
                : result.readiness.groups
                    .find((x) => x.groupId === a.groupId)!
                    .times.map((t) =>
                      timeAsSlot(t, input.termId, a.teacherId!),
                    ),
            ),
          });
          for (const teacher of u.teachers) {
            const def = input.teachers.find((t) => t.id === teacher.teacherId)!;
            const types = e.groups[g].times.flatMap((time) =>
              checkSlot(calendar, timeAsSlot(time, input.termId, def.id)).map(
                (c) => c.type,
              ),
            );
            const minutes =
              result.final.perTeacher.find((p) => p.teacherId === def.id)
                ?.minutes ?? 0;
            const expected = new Set<string>();
            if (def.archived) expected.add("ARCHIVED");
            if (types.includes("TEACHER_UNAVAILABLE_WEEKLY")) {
              expected.add("UNAVAILABLE_WEEKLY");
            }
            // Draft groups are the only bookings in these schools.
            if (types.includes("TEACHER_DOUBLE_BOOKED")) {
              expected.add("TEACHING_IN_DRAFT");
            }
            if (
              def.maxMinutesPerWeek !== null &&
              minutes + e.minutes[g] > def.maxMinutesPerWeek
            ) {
              expected.add("OVER_MAX_HOURS");
            }
            expect(new Set(teacher.reasons.map((r) => r.code))).toEqual(
              expected,
            );
          }
        }
      }
      expect(unassigned).toBeGreaterThan(20);
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it(
    "8. keeps the objective incrementally and ends in a local optimum",
    () => {
      const { input } = realisticGeneratorData(4);
      const { eligibility: e, state, prepared } = analyseForTest(input, false);
      const r = prng(4);
      for (let step = 0; step < 2000; step++) {
        const g = r.int(0, e.groups.length - 1);
        const mark = state.mark();
        state.set(g, r.next() < 0.2 ? -1 : r.pick(e.eligible[g]));
        if (r.next() < 0.3) state.rollback(mark);
        else state.commit();
        if (step % 50 === 0) {
          expect(state.objective()).toEqual(
            recomputeObjective(state, prepared),
          );
        }
      }

      for (const seed of SEEDS) {
        const data = realisticGeneratorData(seed);
        const result = assignTeachers(data.input);
        expect(result.stoppedBy).toBe("converged");
        const final = analyseForTest(
          { ...data.input, assignments: result.assignments },
          true,
        );
        const before = final.state.objective();
        expect(before).toEqual(recomputeObjective(final.state, final.prepared));
        final.eligibility.groups.forEach((_, g) => {
          for (const t of final.eligibility.eligible[g]) {
            if (t === final.state.teacherOf[g] || !final.state.isFree(g, t)) {
              continue;
            }
            const mark = final.state.mark();
            final.state.set(g, t);
            expect(
              final.state.objective().workloadPenalty,
            ).toBeGreaterThanOrEqual(before.workloadPenalty);
            final.state.rollback(mark);
          }
        });
      }
    },
    PROPERTY_TEST_TIMEOUT_MS * 2,
  );

  it(
    "9. matches the exhaustive oracle on small instances (CP-SAT gate)",
    () => {
      let sameUnassigned = 0;
      let withinPenalty = 0;
      const N = 200;
      for (let seed = 1; seed <= N; seed++) {
        const input = smallInstance(1000 + seed);
        const best = oracle(input);
        const result = assignTeachers(input);
        if (result.final.unassignedGroups === best.unassignedGroups) {
          sameUnassigned++;
          if (result.final.workloadPenalty <= best.workloadPenalty * 1.1) {
            withinPenalty++;
          }
        }
      }
      console.log(
        `generator vs oracle: same unassigned ${sameUnassigned}/${N}, penalty within 10% ${withinPenalty}/${N}`,
      );
      expect(sameUnassigned / N).toBeGreaterThanOrEqual(0.99);
      expect(withinPenalty / N).toBeGreaterThanOrEqual(0.95);
    },
    PROPERTY_TEST_TIMEOUT_MS * 2,
  );
});
