// Small hand-written generator inputs for unit tests, on top of the
// scheduling fixtures (Monday 2026-10-12 … Sunday 2026-11-08).

import { context, h, room, TERM } from "./fixtures";
import type {
  DraftAssignmentInput,
  DraftMode,
  GeneratorGroup,
  GeneratorInput,
  GeneratorTeacher,
  LessonTimeInfo,
} from "../generator/types";

import type { SchedulingContext, SlotInfo } from "../types";

export { h, TERM };

export const LEVEL_A = "lvl-a";
export const LEVEL_B = "lvl-b";

export const lt = (
  id: string,
  weekday: number,
  start: number,
  end: number,
  roomId = `room-${id}`,
): LessonTimeInfo => ({
  id,
  weekday,
  startMinute: start,
  endMinute: end,
  roomId,
});

export const grp = (
  id: string,
  levelId: string,
  lessonTimes: LessonTimeInfo[],
  extra: Partial<GeneratorGroup> = {},
): GeneratorGroup => ({
  id,
  name: `Group ${id}`,
  levelId,
  lessonTimes,
  skipped: false,
  ...extra,
});

export const tch = (
  id: string,
  levelIds: string[],
  extra: Partial<GeneratorTeacher> = {},
): GeneratorTeacher => ({
  id,
  name: `Teacher ${id}`,
  levelIds,
  maxMinutesPerWeek: null,
  archived: false,
  ...extra,
});

export type BuildOptions = {
  mode?: DraftMode;
  effectiveFrom?: string | null;
  assignments?: DraftAssignmentInput[];
  slots?: SlotInfo[];
  context?: Partial<SchedulingContext>;
  maxIterations?: number;
};

/**
 * A generator input whose context knows every group, teacher and room
 * used (one room per lesson time unless given; groups have no students).
 */
export function build(
  groups: GeneratorGroup[],
  teachers: GeneratorTeacher[],
  options: BuildOptions = {},
): GeneratorInput {
  const base = context();
  const roomIds = new Set(
    groups.flatMap((g) => g.lessonTimes.map((t) => t.roomId)),
  );
  for (const s of options.slots ?? []) if (s.roomId) roomIds.add(s.roomId);
  return {
    context: {
      ...base,
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        type: "GROUP",
        capacity: 10,
        studentIds: [],
        archived: false,
        levelId: g.levelId,
      })),
      teachers: teachers.map((t) => ({ id: t.id, name: t.name })),
      rooms: [
        ...base.rooms,
        ...[...roomIds]
          .filter((id) => !base.rooms.some((r) => r.id === id))
          .map((id) => room(id)),
      ],
      slots: options.slots ?? [],
      ...options.context,
    },
    termId: TERM.id,
    mode: options.mode ?? "REPLACE",
    effectiveFrom: options.effectiveFrom ?? null,
    groups,
    teachers,
    levels: [
      { id: LEVEL_A, name: "A1" },
      { id: LEVEL_B, name: "B1" },
    ],
    assignments: options.assignments ?? [],
    maxIterations: options.maxIterations,
  };
}

export const teacherOf = (
  result: { assignments: { groupId: string; teacherId: string | null }[] },
  groupId: string,
) => result.assignments.find((a) => a.groupId === groupId)?.teacherId ?? null;

export const liveSlot = (
  id: string,
  groupId: string,
  teacherId: string,
  time: LessonTimeInfo,
  extra: Partial<SlotInfo> = {},
): SlotInfo => ({
  id,
  termId: TERM.id,
  groupId,
  teacherId,
  roomId: time.roomId,
  weekday: time.weekday,
  startMinute: time.startMinute,
  endMinute: time.endMinute,
  validFrom: null,
  validUntil: null,
  ...extra,
});

/** Mondays 09:00–10:30, the fixtures' default slot time. */
export const MON_9 = (id: string, roomId?: string) =>
  lt(id, 1, h(9), h(10, 30), roomId);
