import { z } from "zod";

import { encodeMessage } from "../validation";

/**
 * Levels a teacher teaches and their weekly maximum
 * (docs/design/timetable-generator.md §5.2, generator.md §2.2–2.3). Pure
 * rules shared by the form and the service.
 */

/** `TeacherProfile.maxMinutesPerWeek` CHECK: 15–6000 minutes. */
export const MAX_HOURS = { min: 0.25, max: 100 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const maxHoursError = encodeMessage("validation.hoursRange", MAX_HOURS);

export const teacherLevelsSchema = z.object({
  levelIds: z
    .array(
      z
        .string()
        .regex(UUID, { error: encodeMessage("common.error.unexpected") }),
    )
    .max(200)
    .transform((ids) => [...new Set(ids)]),
  /** Hours a week in quarter hours; null = no limit. */
  maxHours: z
    .number({ error: maxHoursError })
    .min(MAX_HOURS.min, { error: maxHoursError })
    .max(MAX_HOURS.max, { error: maxHoursError })
    .refine((hours) => Number.isInteger(hours * 4), { error: maxHoursError })
    .nullable(),
});

export type TeacherLevelsInput = z.output<typeof teacherLevelsSchema>;

export const hoursToMinutes = (hours: number | null) =>
  hours === null ? null : Math.round(hours * 60);

export const minutesToHours = (minutes: number | null) =>
  minutes === null ? null : Math.round((minutes / 60) * 100) / 100;

export type RankedLevel = { id: string; code: string };

/** Ids of every level up to and including `levelId`, in rank order (§5.2 "Up to…"). */
export function levelsUpTo(
  levels: readonly RankedLevel[],
  levelId: string,
): string[] {
  const index = levels.findIndex((level) => level.id === levelId);
  return index < 0 ? [] : levels.slice(0, index + 1).map((level) => level.id);
}

/**
 * "A1–B2", or "A1, C1–C2": consecutive levels (by rank) collapse into a
 * range. `levels` must be sorted by rank; unknown ids are ignored.
 */
export function levelRangeLabel(
  levels: readonly RankedLevel[],
  selected: Iterable<string>,
): string {
  const chosen = new Set(selected);
  const runs: RankedLevel[][] = [];
  let run: RankedLevel[] = [];
  for (const level of levels) {
    if (chosen.has(level.id)) {
      run.push(level);
    } else if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 0) runs.push(run);
  return runs
    .map((r) => (r.length === 1 ? r[0].code : `${r[0].code}–${r.at(-1)!.code}`))
    .join(", ");
}
