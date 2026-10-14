// Realistic generator input for tests and the benchmark
// (docs/architecture/generator.md §6.1): the realistic school with six
// levels, clash-free lesson times with rooms, teacher levels and some
// weekly maxima. The planted `groupTeacher` assignment is always a full,
// valid assignment. Same seed, same data.

import { buildCalendar, checkSlot } from "../conflicts";
import type {
  GeneratorGroup,
  GeneratorInput,
  GeneratorTeacher,
  LessonTimeInfo,
} from "../generator/types";
import type { AvailabilityRule, SchedulingContext, SlotInfo } from "../types";
import { prng, realisticSchool, type RealisticSchool } from "./realistic";

export const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"].map((code, i) => ({
  id: `lvl-${i}`,
  name: code,
}));

export type RealisticGeneratorData = {
  school: RealisticSchool;
  input: GeneratorInput;
  /** groupId → planted teacher. */
  planted: ReadonlyMap<string, string>;
  /** Weekly minutes per teacher under the planted assignment. */
  plantedMinutes: ReadonlyMap<string, number>;
};

/**
 * `variant: "tight"`: each teacher teaches only the levels of their planted
 * groups, and has extra weekly unavailability outside their planted times.
 */
export function realisticGeneratorData(
  seed: number,
  variant: "normal" | "tight" = "normal",
): RealisticGeneratorData {
  const school = realisticSchool(seed);
  const r = prng(seed * 7919 + 17);
  const home = new Map(school.teachers.map((t) => [t.id, r.int(0, 4)]));
  const levelOf = new Map(
    school.groups.map((g) => {
      const teacher = school.groupTeacher.get(g.id)!;
      return [g.id, home.get(teacher)! + r.int(0, 1)];
    }),
  );

  // Clash-free lesson times with the planted teacher: 2 × 90 min per group,
  // 1 × 60 min for 1-on-1s, in a room that fits.
  const placed: SlotInfo[] = [];
  const contextOf = (): SchedulingContext => ({
    ...school,
    groups: school.groups.map((g) => ({
      ...g,
      levelId: LEVELS[levelOf.get(g.id)!].id,
    })),
    slots: placed,
    lessons: [],
  });
  const lessonTimes = new Map<string, LessonTimeInfo[]>();
  for (const group of school.groups) {
    const oneOnOne = group.type === "ONE_ON_ONE";
    const length = oneOnOne ? 60 : 90;
    const times: LessonTimeInfo[] = [];
    for (let k = 0; k < (oneOnOne ? 1 : 2); k++) {
      const fits = (slot: SlotInfo) =>
        checkSlot(buildCalendar(contextOf()), slot).filter(
          (c) => c.type !== "TEACHER_UNAVAILABLE_ON_DATE",
        ).length === 0;
      const make = (weekday: number, start: number, roomId: string) => ({
        id: `lt-${group.id}-${k}`,
        termId: school.term.id,
        groupId: group.id,
        teacherId: school.groupTeacher.get(group.id)!,
        roomId,
        weekday,
        startMinute: start,
        endMinute: start + length,
        validFrom: null,
        validUntil: null,
      });
      let slot: SlotInfo | null = null;
      for (let attempt = 0; attempt < 40 && !slot; attempt++) {
        const candidate = make(
          r.int(1, 6),
          r.int(16, 38) * 30,
          r.pick(school.rooms).id,
        );
        if (
          !times.some((t) => t.weekday === candidate.weekday) &&
          fits(candidate)
        ) {
          slot = candidate;
        }
      }
      // Exhaustive fallback so every group gets its times.
      for (let w = 1; w <= 6 && !slot; w++) {
        for (let s = 16; s <= 38 && !slot; s++) {
          for (const room of school.rooms) {
            const candidate = make(w, s * 30, room.id);
            if (fits(candidate)) {
              slot = candidate;
              break;
            }
          }
        }
      }
      if (!slot) throw new Error(`No clash-free time for ${group.id}`);
      placed.push(slot);
      times.push({
        id: slot.id,
        weekday: slot.weekday,
        startMinute: slot.startMinute,
        endMinute: slot.endMinute,
        roomId: slot.roomId!,
      });
    }
    lessonTimes.set(group.id, times);
  }

  const plantedMinutes = new Map<string, number>();
  for (const slot of placed) {
    plantedMinutes.set(
      slot.teacherId,
      (plantedMinutes.get(slot.teacherId) ?? 0) +
        slot.endMinute -
        slot.startMinute,
    );
  }

  const availability: AvailabilityRule[] = [...school.availability];
  const teachers: GeneratorTeacher[] = school.teachers.map((t, i) => {
    const plantedLevels = school.groups
      .filter((g) => school.groupTeacher.get(g.id) === t.id)
      .map((g) => levelOf.get(g.id)!);
    let levelIdx: number[];
    if (variant === "tight") {
      levelIdx = [...new Set(plantedLevels)];
    } else {
      const from = home.get(t.id)!;
      const to = Math.min(5, from + r.int(1, 3));
      levelIdx = Array.from({ length: to - from + 1 }, (_, k) => from + k);
    }
    const load = plantedMinutes.get(t.id) ?? 0;
    return {
      id: t.id,
      name: t.name,
      levelIds: levelIdx.sort((a, b) => a - b).map((l) => LEVELS[l].id),
      maxMinutesPerWeek:
        i % 4 === 0 ? Math.max(60, load + r.int(0, 2) * 90) : null,
      archived: false,
    };
  });

  if (variant === "tight") {
    // Block one more evening per teacher, away from their planted times.
    for (const teacher of school.teachers) {
      const mine = placed.filter((s) => s.teacherId === teacher.id);
      for (let attempt = 0; attempt < 10; attempt++) {
        const weekday = r.int(1, 6);
        const start = r.int(28, 36) * 30;
        const end = start + 180;
        const clash = mine.some(
          (s) =>
            s.weekday === weekday && s.startMinute < end && start < s.endMinute,
        );
        if (clash) continue;
        availability.push({
          id: `av-${teacher.id}-tight`,
          teacherId: teacher.id,
          kind: "WEEKLY_UNAVAILABLE",
          weekday,
          date: null,
          startMinute: start,
          endMinute: end,
        });
        break;
      }
    }
  }

  const groups: GeneratorGroup[] = school.groups.map((g) => ({
    id: g.id,
    name: g.name,
    levelId: LEVELS[levelOf.get(g.id)!].id,
    lessonTimes: lessonTimes.get(g.id)!,
    skipped: false,
  }));

  const input: GeneratorInput = {
    context: {
      ...contextOf(),
      slots: [],
      availability,
    },
    termId: school.term.id,
    mode: "REPLACE",
    effectiveFrom: null,
    groups,
    teachers,
    levels: LEVELS,
    assignments: [],
  };
  return {
    school,
    input,
    planted: school.groupTeacher,
    plantedMinutes,
  };
}

/** Planted slots of the realistic school as live slots of its term. */
export function plantedSlots(data: RealisticGeneratorData): SlotInfo[] {
  return data.input.groups.flatMap((g) =>
    g.lessonTimes.map((t) => ({
      id: `live-${t.id}`,
      termId: data.input.termId,
      groupId: g.id,
      teacherId: data.planted.get(g.id)!,
      roomId: t.roomId,
      weekday: t.weekday,
      startMinute: t.startMinute,
      endMinute: t.endMinute,
      validFrom: null,
      validUntil: null,
    })),
  );
}
