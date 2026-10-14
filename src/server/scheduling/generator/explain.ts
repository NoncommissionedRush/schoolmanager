// Why a group has no teacher, what the admin could do about it
// (generator.md §4.5), and the teacher picker's sections (§5.3).

import { formatMinutes } from "../time";
import { type Eligibility, reasonOrder, rule3Reasons } from "./eligibility";
import type { Prepared } from "./readiness";
import type { AssignmentState } from "./score";
import type {
  GroupReasonCode,
  Suggestion,
  TeacherReason,
  TeacherReasons,
  UnassignedGroup,
} from "./types";

const MAX_SUGGESTIONS = 3;
const MAX_NOT_TEACHING_LEVEL = 2;

const range = (t: { startMinute: number; endMinute: number }) =>
  `${formatMinutes(t.startMinute)}–${formatMinutes(t.endMinute)}`;

/** Rules 4–5 reasons of teacher `t` for group `g` given the draft (§4.5). */
export function draftReasons(
  prepared: Prepared,
  state: AssignmentState,
  g: number,
  t: number,
): TeacherReason[] {
  const { e } = state;
  const out: TeacherReason[] = [];
  const others = [...state.groupsOf[t]]
    .filter((h) => h !== g && e.overlaps[g].has(h))
    .sort((a, b) => a - b);
  for (const h of others) {
    const pairs = e.overlapTimes.get(g < h ? `${g}|${h}` : `${h}|${g}`) ?? [];
    for (const [x, y] of pairs) {
      const [mine, theirs] = g < h ? [x, y] : [y, x];
      const time = e.groups[g].times[mine];
      const other = e.groups[h].times[theirs];
      out.push({
        code: "TEACHING_IN_DRAFT",
        params: {
          weekday: time.weekday,
          otherGroup: prepared.groupName(e.groups[h].groupId),
          otherTime: range(other),
          locked: state.locked[h] ? "yes" : "no",
        },
        refs: { teacherId: e.teachers[t].id, groupId: e.groups[h].groupId },
      });
    }
  }
  const max = e.teachers[t].maxMinutesPerWeek;
  const current =
    state.minutes[t] - (state.teacherOf[g] === t ? e.minutes[g] : 0);
  if (max !== null && current + e.minutes[g] > max) {
    out.push({
      code: "OVER_MAX_HOURS",
      params: {
        currentMinutes: current,
        withMinutes: current + e.minutes[g],
        maxMinutes: max,
      },
      refs: { teacherId: e.teachers[t].id },
    });
  }
  return out;
}

/** Every reason teacher `t` can't take `g`: rules 1–3, then 4–5. */
function allReasons(
  prepared: Prepared,
  state: AssignmentState,
  g: number,
  t: number,
): TeacherReason[] {
  const statics = state.e.staticReasons[g].get(t) ?? [];
  return [...statics, ...draftReasons(prepared, state, g, t)].sort(
    (a, b) => reasonOrder.indexOf(a.code) - reasonOrder.indexOf(b.code),
  );
}

/** Teachers of the group's level: non-archived by name, archived last. */
function levelTeachers(e: Eligibility, g: number): number[] {
  const levelId = e.groups[g].levelId;
  return e.teachers
    .map((teacher, t) => ({ teacher, t }))
    .filter(({ teacher }) => teacher.levelIds.includes(levelId))
    .sort(
      (a, b) =>
        Number(a.teacher.archived) - Number(b.teacher.archived) ||
        (a.teacher.name < b.teacher.name
          ? -1
          : a.teacher.name > b.teacher.name
            ? 1
            : a.t - b.t),
    )
    .map(({ t }) => t);
}

/** Whether `t` is free at all of `g`'s times by rules 3–5 (level ignored). */
function freeIgnoringLevel(
  state: AssignmentState,
  g: number,
  t: number,
): boolean {
  const { e } = state;
  const teacher = e.teachers[t];
  if (teacher.archived) return false;
  for (const time of e.groups[g].times) {
    if (rule3Reasons(time, e.teacherConflicts(teacher.id, time)).length > 0) {
      return false;
    }
  }
  return state.isFree(g, t);
}

function suggestions(
  prepared: Prepared,
  state: AssignmentState,
  g: number,
  reasons: Map<number, TeacherReason[]>,
): Suggestion[] {
  const { e } = state;
  const out: Suggestion[] = [];

  // SWAP: t is blocked only by one other draft group h, and someone else
  // can take h once g goes to t.
  const swaps: Extract<Suggestion, { kind: "SWAP" }>[] = [];
  for (const [t, list] of reasons) {
    if (e.teachers[t].archived || !e.eligible[g].includes(t)) continue;
    if (list.length === 0 || list.some((r) => r.code !== "TEACHING_IN_DRAFT")) {
      continue;
    }
    const blockers = new Set(list.map((r) => r.refs.groupId));
    if (blockers.size !== 1) continue;
    const hId = [...blockers][0];
    const h = e.groups.findIndex((x) => x.groupId === hId);
    if (h < 0 || !state.isFree(g, t, [h])) continue;
    let best: { u: number; penalty: number } | null = null;
    for (const u of e.eligible[h]) {
      if (u === t || !state.isFree(h, u)) continue;
      const mark = state.mark();
      state.set(h, u);
      state.set(g, t);
      const penalty = state.objective().workloadPenalty;
      state.rollback(mark);
      if (!best || penalty < best.penalty) best = { u, penalty };
    }
    if (best) {
      swaps.push({
        kind: "SWAP",
        teacherId: e.teachers[t].id,
        otherGroupId: hId!,
        otherTeacherId: e.teachers[best.u].id,
        otherLocked: !!state.locked[h],
        workloadPenalty: best.penalty,
      });
    }
  }
  swaps.sort(
    (a, b) =>
      a.workloadPenalty - b.workloadPenalty ||
      (a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0),
  );
  out.push(...swaps);

  const only = (code: TeacherReason["code"]) =>
    [...reasons]
      .filter(
        ([t, list]) =>
          !e.teachers[t].archived &&
          list.length > 0 &&
          list.every((r) => r.code === code),
      )
      .map(([t]) => t)
      .sort((a, b) => a - b);
  for (const t of only("UNAVAILABLE_WEEKLY")) {
    out.push({ kind: "ONLY_UNAVAILABLE", teacherId: e.teachers[t].id });
  }
  for (const t of only("OVER_MAX_HOURS")) {
    out.push({ kind: "ONLY_MAX_HOURS", teacherId: e.teachers[t].id });
  }

  const levelId = e.groups[g].levelId;
  let others = 0;
  for (let t = 0; t < e.teachers.length; t++) {
    if (others >= MAX_NOT_TEACHING_LEVEL || out.length >= MAX_SUGGESTIONS) {
      break;
    }
    if (e.teachers[t].levelIds.includes(levelId)) continue;
    if (!freeIgnoringLevel(state, g, t)) continue;
    out.push({ kind: "NOT_TEACHING_LEVEL", teacherId: e.teachers[t].id });
    others++;
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

/** §4.5 for every included group left without a teacher. */
export function explainUnassigned(
  prepared: Prepared,
  state: AssignmentState,
  causes: ReadonlyMap<number, GroupReasonCode>,
): UnassignedGroup[] {
  const { e } = state;
  const out: UnassignedGroup[] = [];
  e.groups.forEach((group, g) => {
    if (state.teacherOf[g] >= 0) return;
    const teachers = levelTeachers(e, g);
    const reasons = new Map<number, TeacherReason[]>();
    const list: TeacherReasons[] = teachers.map((t) => {
      const r = allReasons(prepared, state, g, t);
      reasons.set(t, r);
      return {
        teacherId: e.teachers[t].id,
        archived: e.teachers[t].archived,
        reasons: r,
      };
    });
    const active = teachers.filter((t) => !e.teachers[t].archived).length;
    const reason: GroupReasonCode =
      causes.get(g) ??
      (state.locked[g]
        ? "REMOVED_BY_ADMIN"
        : group.status === "LEVEL_UNCOVERED" || active === 0
          ? "LEVEL_UNCOVERED"
          : "NO_TEACHER_FITS");
    out.push({
      groupId: group.groupId,
      levelId: group.levelId,
      reason,
      params: { level: prepared.levelName(group.levelId), teachers: active },
      teachers: list,
      suggestions:
        reason === "REMOVED_BY_ADMIN"
          ? []
          : suggestions(prepared, state, g, reasons),
    });
  });
  return out;
}

export type PickerSection =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "NOT_TEACHING_LEVEL"
  | "OVER_MAX_HOURS"
  | "BUSY";

export type TeacherOption = {
  teacherId: string;
  section: PickerSection;
  reasons: TeacherReason[];
  /** One-off unavailability on some dates: a warning, acknowledged on apply. */
  datedUnavailability: number;
};

/**
 * The picker for group `g` (§5.3): every non-archived teacher with the
 * section they fall in. Busy teachers can't be saved.
 */
export function teacherOptions(
  prepared: Prepared,
  state: AssignmentState,
  g: number,
): TeacherOption[] {
  const { e } = state;
  const group = e.groups[g];
  const out: TeacherOption[] = [];
  e.teachers.forEach((teacher, t) => {
    if (teacher.archived) return;
    const reasons: TeacherReason[] = [];
    let dated = 0;
    for (const time of group.times) {
      const conflicts = e.teacherConflicts(teacher.id, time);
      reasons.push(...rule3Reasons(time, conflicts));
      dated += conflicts.filter(
        (c) => c.type === "TEACHER_UNAVAILABLE_ON_DATE",
      ).length;
    }
    reasons.push(...draftReasons(prepared, state, g, t));
    reasons.sort(
      (a, b) => reasonOrder.indexOf(a.code) - reasonOrder.indexOf(b.code),
    );
    const has = (code: TeacherReason["code"]) =>
      reasons.some((r) => r.code === code);
    const section: PickerSection =
      has("BUSY") || has("TEACHING_IN_DRAFT")
        ? "BUSY"
        : !teacher.levelIds.includes(group.levelId)
          ? "NOT_TEACHING_LEVEL"
          : has("UNAVAILABLE_WEEKLY")
            ? "UNAVAILABLE"
            : has("OVER_MAX_HOURS")
              ? "OVER_MAX_HOURS"
              : "AVAILABLE";
    out.push({
      teacherId: teacher.id,
      section,
      reasons,
      datedUnavailability: dated,
    });
  });
  return out;
}
