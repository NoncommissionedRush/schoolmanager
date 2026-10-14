import { describe, expect, it } from "vitest";

import { realisticGeneratorData } from "../testing/generator";
import { PROPERTY_TEST_TIMEOUT_MS } from "../testing/realistic";
import { assignTeachers, compareObjectives } from ".";
import { computeEligibility } from "./eligibility";
import { prepare } from "./readiness";

// Performance target of docs/architecture/generator.md §6.2 on the realistic
// school (20 teachers, 60 groups, ~330 students). Limits are for a dev
// laptop; CI is slower, so the assertions allow 3× and the measured values
// are printed.

const SEEDS = [1, 2, 3, 4, 5];
const RUN_LIMIT_MS = 1000;
const ELIGIBILITY_LIMIT_MS = 300;
const SLACK = 3;

const range = (values: number[]) => Math.max(...values) - Math.min(...values);

describe("generator performance (§6.2)", () => {
  for (const variant of ["normal", "tight"] as const) {
    it(
      `${variant}: staffs the groups within the time budget`,
      () => {
        const rows: string[] = [];
        let fullSeeds = 0;
        for (const seed of SEEDS) {
          const data = realisticGeneratorData(seed, variant);

          const t0 = performance.now();
          const prepared = prepare(data.input);
          computeEligibility(prepared);
          const eligibilityMs = performance.now() - t0;

          const t1 = performance.now();
          const result = assignTeachers(data.input, {
            clock: () => performance.now(),
          });
          const runMs = performance.now() - t1;

          const total = result.assignments.length;
          const staffed = total - result.final.unassignedGroups;
          if (staffed === total) fullSeeds++;
          const pool = result.final.perTeacher.map((p) => p.teacherId);
          const plantedRange = range(
            pool.map((id) => data.plantedMinutes.get(id) ?? 0),
          );
          rows.push(
            `seed ${seed}: ${staffed}/${total} staffed, range ${result.final.workloadRange} min ` +
              `(planted ${plantedRange}), run ${runMs.toFixed(0)} ms, ` +
              `eligibility ${eligibilityMs.toFixed(0)} ms, ` +
              `${result.iterations} iterations, ${result.stoppedBy}`,
          );

          expect(total).toBe(60);
          expect(staffed / total).toBeGreaterThanOrEqual(0.98);
          expect(result.unassigned).toHaveLength(total - staffed);
          expect(result.stoppedBy).toBe("converged");
          expect(
            compareObjectives(result.final, result.construction),
          ).toBeLessThanOrEqual(0);
          if (variant === "normal") {
            expect(staffed).toBe(total);
            expect(result.final.workloadRange).toBeLessThanOrEqual(
              plantedRange,
            );
          }
          expect(runMs).toBeLessThan(RUN_LIMIT_MS * SLACK);
          expect(eligibilityMs).toBeLessThan(ELIGIBILITY_LIMIT_MS * SLACK);
        }
        console.log(`generator ${variant}:\n  ${rows.join("\n  ")}`);
        expect(fullSeeds).toBeGreaterThanOrEqual(variant === "normal" ? 5 : 4);
      },
      PROPERTY_TEST_TIMEOUT_MS * 2,
    );
  }
});
