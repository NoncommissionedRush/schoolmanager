// Which groups take part in a run, with which times, against which fixed
// context (generator.md §2.4, §2.5, §4.2 steps 1–2).

import type { Conflict } from "../conflict-types";
import {
  buildCalendar,
  type Calendar,
  checkSlot,
  UNASSIGNED_TEACHER,
} from "../conflicts";
import { compareStrings } from "../generate-lessons";
import { addDays, type IsoDate } from "../time";
import type { SchedulingContext, SlotInfo, TermInfo } from "../types";
import type {
  DraftConflict,
  DraftTime,
  GeneratorGroup,
  GeneratorInput,
  GeneratorTeacher,
  GroupReadiness,
  ReadinessChecks,
  ReadinessStatus,
} from "./types";
import type { Eligibility } from "./eligibility";

/** Time conflicts no teacher can fix: the group is left out (`TIMES_CLASH`). */
export const TIME_BLOCKING_CONFLICTS: ReadonlySet<string> = new Set([
  "ROOM_DOUBLE_BOOKED",
  "GROUP_DOUBLE_BOOKED",
  "OUTSIDE_TERM",
  "INVALID_TIME",
]);

const byId = <T extends { id: string }>(a: T, b: T) =>
  compareStrings(a.id, b.id);
const sortedById = <T extends { id: string }>(items: readonly T[]) =>
  [...items].sort(byId);

/**
 * The input with every array in a canonical order, so the result never
 * depends on the order the database returned rows in (§4.4).
 */
export function normalizeInput(input: GeneratorInput): GeneratorInput {
  const c = input.context;
  const pair = (a: { lessonId: string; studentId: string }) =>
    `${a.lessonId}|${a.studentId}`;
  return {
    ...input,
    context: {
      ...c,
      school: {
        ...c.school,
        teachingWeekdays: [...c.school.teachingWeekdays].sort((a, b) => a - b),
      },
      terms: sortedById(c.terms),
      holidays: sortedById(c.holidays),
      slots: sortedById(c.slots),
      lessons: sortedById(c.lessons),
      groups: sortedById(c.groups).map((g) => ({
        ...g,
        studentIds: [...g.studentIds].sort(compareStrings),
      })),
      rooms: sortedById(c.rooms),
      teachers: sortedById(c.teachers),
      students: sortedById(c.students),
      availability: sortedById(c.availability),
      absences: c.absences
        ? [...c.absences].sort((a, b) => compareStrings(pair(a), pair(b)))
        : undefined,
      replacements: c.replacements
        ? [...c.replacements].sort((a, b) => compareStrings(pair(a), pair(b)))
        : undefined,
      teacherLevels: undefined,
      levels: c.levels ? sortedById(c.levels) : undefined,
    },
    groups: sortedById(input.groups).map((g) => ({
      ...g,
      lessonTimes: sortedById(g.lessonTimes),
    })),
    teachers: sortedById(input.teachers).map((t) => ({
      ...t,
      levelIds: [...new Set(t.levelIds)].sort(compareStrings),
    })),
    levels: sortedById(input.levels),
    assignments: [...input.assignments].sort((a, b) =>
      compareStrings(a.groupId, b.groupId),
    ),
  };
}

/** Everything the later steps share. */
export type Prepared = {
  input: GeneratorInput;
  term: TermInfo;
  startDate: IsoDate;
  /** What the generator may not change (§4.2 step 2), with teacher levels. */
  fixedContext: SchedulingContext;
  fixedCalendar: Calendar;
  groups: GroupReadiness[];
  groupById: ReadonlyMap<string, GeneratorGroup>;
  teachers: readonly GeneratorTeacher[];
  teacherById: ReadonlyMap<string, GeneratorTeacher>;
  levelName: (levelId: string) => string;
  groupName: (groupId: string) => string;
  /** Weekly minutes and weekdays of kept live slots of the term, per teacher (§2.3). */
  baselineMinutes: ReadonlyMap<string, number>;
  baselineDays: ReadonlyMap<string, ReadonlySet<number>>;
};

const minutesOf = (t: { startMinute: number; endMinute: number }) =>
  t.endMinute - t.startMinute;

/** Whether a slot is in effect on `date` or later within the term. */
const inEffectFrom = (slot: SlotInfo, date: IsoDate, term: TermInfo) =>
  (!slot.validUntil || slot.validUntil >= date) &&
  (slot.validFrom ?? term.startDate) <= term.endDate &&
  date <= term.endDate;

/** The draft time as a slot for the checker (`id` = `draft:<key>`). */
export function timeAsSlot(
  time: DraftTime,
  termId: string,
  teacherId: string,
): SlotInfo {
  return {
    id: `draft:${time.key}`,
    termId,
    groupId: time.groupId,
    teacherId,
    roomId: time.roomId,
    weekday: time.weekday,
    startMinute: time.startMinute,
    endMinute: time.endMinute,
    validFrom: time.validFrom,
    validUntil: time.validUntil,
  };
}

export function toDraftConflict(
  groupId: string,
  time: DraftTime,
  conflict: Conflict,
): DraftConflict {
  return {
    ...conflict,
    timeKey: time.key,
    draftKey: `${groupId}|${time.weekday}|${time.startMinute}|${time.endMinute}|${conflict.key}`,
  };
}

/** The teacher a group's live slots from `date` on agree on (§5.2). */
function currentTeacher(slots: readonly SlotInfo[]): {
  teacherId: string | null;
  mixed: boolean;
} {
  const ids = [...new Set(slots.map((s) => s.teacherId))];
  if (ids.length === 1) return { teacherId: ids[0], mixed: false };
  return { teacherId: null, mixed: ids.length > 1 };
}

/**
 * Snapshot → included groups, their times and the fixed context
 * (§4.2 steps 1–2). Readiness of every non-archived group (§2.5).
 */
export function prepare(raw: GeneratorInput): Prepared {
  const input = normalizeInput(raw);
  const { context, termId, mode } = input;
  const term = context.terms.find((t) => t.id === termId);
  if (!term) throw new Error(`Generator input is missing term ${termId}`);
  if (mode !== "REPLACE" && !input.effectiveFrom) {
    throw new Error(`${mode} needs an effective date`);
  }
  const startDate =
    mode === "REPLACE" ? term.startDate : (input.effectiveFrom as IsoDate);
  const rooms = new Map(context.rooms.map((r) => [r.id, r]));
  const levels = new Map(input.levels.map((l) => [l.id, l.name]));
  const groupNames = new Map(context.groups.map((g) => [g.id, g.name]));

  const termSlots = context.slots.filter((s) => s.termId === termId);
  const liveFrom = new Map<string, SlotInfo[]>();
  for (const slot of termSlots) {
    if (!inEffectFrom(slot, startDate, term)) continue;
    const list = liveFrom.get(slot.groupId);
    if (list) list.push(slot);
    else liveFrom.set(slot.groupId, [slot]);
  }

  const teacherLevels = input.teachers.flatMap((t) =>
    t.levelIds.map((levelId) => ({ teacherId: t.id, levelId })),
  );
  const nonArchivedLevels = new Set(
    input.teachers.filter((t) => !t.archived).flatMap((t) => t.levelIds),
  );

  // Times per group (§2.4).
  const groups: GroupReadiness[] = input.groups.map((group) => {
    const live = mode === "REPLACE" ? [] : (liveFrom.get(group.id) ?? []);
    const current = currentTeacher(
      mode === "REPLACE" ? (liveFrom.get(group.id) ?? []) : live,
    );
    const base: GroupReadiness = {
      groupId: group.id,
      levelId: group.levelId,
      status: "READY",
      times: [],
      minutes: 0,
      currentTeacherId: current.teacherId,
      mixedTeachers: current.mixed,
      clashes: [],
      timeWarnings: [],
    };
    if (group.skipped) return { ...base, status: "SKIPPED" };
    if (mode === "FILL" && live.length > 0) return { ...base, status: "KEPT" };
    const times: DraftTime[] =
      live.length > 0
        ? live.map((slot) => ({
            key: `slot:${slot.id}`,
            groupId: group.id,
            weekday: slot.weekday,
            startMinute: slot.startMinute,
            endMinute: slot.endMinute,
            roomId: slot.roomId,
            validFrom:
              slot.validFrom && slot.validFrom > startDate
                ? slot.validFrom
                : startDate,
            validUntil: slot.validUntil,
            liveSlotId: slot.id,
            lessonTimeId: null,
          }))
        : group.lessonTimes.map((lt) => ({
            key: `lt:${lt.id}`,
            groupId: group.id,
            weekday: lt.weekday,
            startMinute: lt.startMinute,
            endMinute: lt.endMinute,
            roomId: lt.roomId,
            validFrom: mode === "REPLACE" ? null : startDate,
            validUntil: null,
            liveSlotId: null,
            lessonTimeId: lt.id,
          }));
    const minutes = times.reduce((n, t) => n + minutesOf(t), 0);
    if (times.length === 0) return { ...base, status: "NO_LESSON_TIMES" };
    const roomless = times.some(
      (t) =>
        t.lessonTimeId !== null &&
        (!t.roomId || !rooms.has(t.roomId) || rooms.get(t.roomId)!.archived),
    );
    if (roomless) return { ...base, times, minutes, status: "NO_ROOM" };
    return { ...base, times, minutes };
  });

  // Fixed context (§4.2 step 2): REPLACE replaces the term's slots;
  // REPLAN_FROM takes the reconsidered groups' slots out from _D_ on.
  const dayBefore = addDays(startDate, -1);
  const fixedFor = (reconsidered: ReadonlySet<string>) => {
    const removedSlots = new Set<string>();
    const slots: SlotInfo[] = [];
    for (const slot of context.slots) {
      if (slot.termId === termId && mode === "REPLACE") continue;
      if (
        slot.termId === termId &&
        reconsidered.has(slot.groupId) &&
        inEffectFrom(slot, startDate, term)
      ) {
        removedSlots.add(slot.id);
        slots.push({ ...slot, validUntil: dayBefore });
        continue;
      }
      slots.push(slot);
    }
    const fixed: SchedulingContext = {
      ...context,
      slots,
      lessons: context.lessons.filter(
        (l) =>
          !(
            l.timetableSlotId &&
            removedSlots.has(l.timetableSlotId) &&
            l.occurrenceDate &&
            l.occurrenceDate >= startDate
          ),
      ),
      teacherLevels,
      levels: input.levels.map((l) => ({ id: l.id, name: l.name })),
    };
    return fixed;
  };
  const reconsideredOf = (statuses: readonly ReadinessStatus[]) =>
    new Set(
      mode === "REPLAN_FROM"
        ? groups
            .filter(
              (g) => statuses.includes(g.status) && liveFrom.has(g.groupId),
            )
            .map((g) => g.groupId)
        : [],
    );
  const candidates = groups.filter((g) => g.status === "READY");
  const firstReconsidered = reconsideredOf(["READY"]);
  let fixedContext = fixedFor(firstReconsidered);

  // Time conflicts against the fixed context plus the other candidates.
  const withCandidates = buildCalendar({
    ...fixedContext,
    slots: [
      ...fixedContext.slots,
      ...candidates.flatMap((g) =>
        g.times.map((t) => timeAsSlot(t, termId, UNASSIGNED_TEACHER)),
      ),
    ],
  });
  for (const group of candidates) {
    for (const time of group.times) {
      const conflicts = checkSlot(
        withCandidates,
        timeAsSlot(time, termId, UNASSIGNED_TEACHER),
      ).map((c) => toDraftConflict(group.groupId, time, c));
      for (const conflict of conflicts) {
        if (TIME_BLOCKING_CONFLICTS.has(conflict.type)) {
          group.clashes.push(conflict);
        } else if (conflict.severity === "overridable") {
          group.timeWarnings.push(conflict);
        }
      }
    }
    if (group.clashes.length > 0) group.status = "TIMES_CLASH";
    else if (!nonArchivedLevels.has(group.levelId)) {
      group.status = "LEVEL_UNCOVERED";
    }
  }
  // A group left out keeps its live slots: they stay as they are.
  const reconsidered = reconsideredOf(["READY", "LEVEL_UNCOVERED"]);
  if (reconsidered.size !== firstReconsidered.size) {
    fixedContext = fixedFor(reconsidered);
  }
  const fixedCalendar = buildCalendar(fixedContext);
  const fixedSlots = fixedContext.slots;

  // Kept live slots of the term count toward their teachers (§2.3).
  // TODO(generator.md §11 "Kept live minutes"): a slot that is ending and
  // its successor both count here, and so do a reconsidered group's own
  // times; safe for rule 5 but it can refuse a teacher who would fit.
  const baselineMinutes = new Map<string, number>();
  const baselineDays = new Map<string, Set<number>>();
  for (const slot of fixedSlots) {
    if (slot.termId !== termId || !inEffectFrom(slot, startDate, term)) {
      continue;
    }
    baselineMinutes.set(
      slot.teacherId,
      (baselineMinutes.get(slot.teacherId) ?? 0) + minutesOf(slot),
    );
    const days = baselineDays.get(slot.teacherId) ?? new Set<number>();
    days.add(slot.weekday);
    baselineDays.set(slot.teacherId, days);
  }

  return {
    input,
    term,
    startDate,
    fixedContext,
    fixedCalendar,
    groups,
    groupById: new Map(input.groups.map((g) => [g.id, g])),
    teachers: input.teachers,
    teacherById: new Map(input.teachers.map((t) => [t.id, t])),
    levelName: (id) => levels.get(id) ?? id,
    groupName: (id) => groupNames.get(id) ?? id,
    baselineMinutes,
    baselineDays,
  };
}

/** Groups that take part in the run (READY and LEVEL_UNCOVERED), by id. */
export const includedGroups = (prepared: Prepared) =>
  prepared.groups.filter(
    (g) => g.status === "READY" || g.status === "LEVEL_UNCOVERED",
  );

/** Weekly minutes a teacher without a maximum can give (§2.5 `hours`). */
function weeklyCapacity(prepared: Prepared, teacherId: string): number {
  const { school, availability } = prepared.fixedContext;
  const { dayStartMinute: start, dayEndMinute: end } = school;
  let total = 0;
  for (const weekday of school.teachingWeekdays) {
    const blocked = availability
      .filter(
        (r) =>
          r.teacherId === teacherId &&
          r.kind === "WEEKLY_UNAVAILABLE" &&
          r.weekday === weekday,
      )
      .map((r) => [
        Math.max(start, r.startMinute ?? start),
        Math.min(end, r.endMinute ?? end),
      ])
      .filter(([a, b]) => a < b)
      .sort((x, y) => x[0] - y[0]);
    let free = end - start;
    let reached = start;
    for (const [a, b] of blocked) {
      const from = Math.max(a, reached);
      if (b > from) free -= b - from;
      reached = Math.max(reached, b);
    }
    total += Math.max(0, free);
  }
  return total;
}

/** The readiness card's checks (§2.5), from the data a run uses. */
export function readinessChecks(
  prepared: Prepared,
  e: Eligibility,
): ReadinessChecks {
  const { groups } = prepared;
  const noTimes = groups
    .filter((g) => g.status === "NO_LESSON_TIMES" || g.status === "NO_ROOM")
    .map((g) => g.groupId);

  const pairs = new Map<string, ReadinessChecks["roomClash"][number]>();
  for (const group of groups) {
    if (group.status !== "TIMES_CLASH") continue;
    for (const c of group.clashes) {
      if (
        c.type !== "ROOM_DOUBLE_BOOKED" ||
        !c.refs.groupId ||
        !c.refs.roomId
      ) {
        continue;
      }
      const [a, b] = [group.groupId, c.refs.groupId].sort(compareStrings);
      pairs.set(`${a}|${b}|${c.refs.roomId}`, {
        groupId: a,
        otherGroupId: b,
        roomId: c.refs.roomId,
      });
    }
  }
  const roomClash = [...pairs.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([, v]) => v);

  const levelUncovered = [
    ...new Set(
      groups
        .filter((g) => g.status === "LEVEL_UNCOVERED")
        .map((g) => g.levelId),
    ),
  ].sort(compareStrings);

  // Hall's condition at each start time, for all groups and per level.
  const timeCrunch: ReadinessChecks["timeCrunch"] = [];
  const seen = new Set<string>();
  const starts = new Map<string, { weekday: number; minute: number }>();
  for (const group of e.groups) {
    for (const t of group.times) {
      starts.set(`${t.weekday}|${String(t.startMinute).padStart(4, "0")}`, {
        weekday: t.weekday,
        minute: t.startMinute,
      });
    }
  }
  for (const [, { weekday, minute }] of [...starts].sort(([a], [b]) =>
    compareStrings(a, b),
  )) {
    const active = e.groups
      .map((group, g) => ({ group, g }))
      .filter(({ group }) =>
        group.times.some(
          (t) =>
            t.weekday === weekday &&
            t.startMinute <= minute &&
            minute < t.endMinute,
        ),
      );
    const subsets: { levelId: string | null; members: number[] }[] = [];
    const levelIds = [...new Set(active.map((a) => a.group.levelId))].sort(
      compareStrings,
    );
    if (levelIds.length > 1) {
      subsets.push({ levelId: null, members: active.map((a) => a.g) });
    }
    for (const levelId of levelIds) {
      subsets.push({
        levelId,
        members: active
          .filter((a) => a.group.levelId === levelId)
          .map((a) => a.g),
      });
    }
    for (const { levelId, members } of subsets) {
      const teachers = new Set(members.flatMap((g) => e.eligible[g])).size;
      if (members.length <= teachers) continue;
      const key = `${levelId}|${members.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      timeCrunch.push({
        weekday,
        minute,
        levelId,
        groups: members.length,
        teachers,
      });
    }
  }

  const teachersNoLevels = prepared.teachers
    .filter((t) => !t.archived && t.levelIds.length === 0)
    .map((t) => t.id);

  const neededMinutes = e.groups.reduce((n, g) => n + g.minutes, 0);
  let availableMinutes = 0;
  for (const t of e.pool) {
    const teacher = e.teachers[t];
    const capacity =
      teacher.maxMinutesPerWeek ?? weeklyCapacity(prepared, teacher.id);
    // Kept live lessons already use part of it.
    availableMinutes += Math.max(
      0,
      capacity - (prepared.baselineMinutes.get(teacher.id) ?? 0),
    );
  }

  const studentClash = e.groups
    .filter((g) =>
      g.timeWarnings.some((c) => c.type === "STUDENT_DOUBLE_BOOKED"),
    )
    .map((g) => g.groupId);

  return {
    noTimes,
    roomClash,
    levelUncovered,
    timeCrunch,
    teachersNoLevels,
    hours: { neededMinutes, availableMinutes },
    studentClash,
  };
}
