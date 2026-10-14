// Who may get which group (generator.md §3.1 rules 1–3, §4.2 step 3), and
// which groups can't share a teacher (the overlap graph).

import type { Conflict } from "../conflict-types";
import { checkSlot, holidaysOfTerm } from "../conflicts";
import { slotOccurrenceDates } from "../generate-lessons";
import type { IsoDate } from "../time";
import { includedGroups, type Prepared, timeAsSlot } from "./readiness";
import type {
  DraftTime,
  GeneratorTeacher,
  GroupReadiness,
  TeacherReason,
} from "./types";

/** Conflicts about the teacher that `checkSlot` reports for a time. */
const TEACHER_TYPED = new Set([
  "TEACHER_DOUBLE_BOOKED",
  "TEACHER_UNAVAILABLE_WEEKLY",
  "TEACHER_UNAVAILABLE_ON_DATE",
]);

export type Eligibility = {
  /** Included groups, by id; indices below refer to this list. */
  groups: GroupReadiness[];
  /** Every teacher, by id; indices below refer to this list. */
  teachers: readonly GeneratorTeacher[];
  /** _E_(_g_): non-archived teachers of the level free by rule 3, by id. */
  eligible: number[][];
  /** Rules 1–3 reasons of every teacher of the level who is not in _E_(_g_). */
  staticReasons: Map<number, TeacherReason[]>[];
  /** One-off unavailability per group and teacher of _E_(_g_) (warnings, §3.1). */
  onDate: Map<number, Conflict[]>[];
  /** Groups whose times overlap (rule 4), by index. */
  overlaps: Set<number>[];
  /** For each overlapping pair `i|j` (i < j): pairs of time indices. */
  overlapTimes: Map<string, [number, number][]>;
  /** Non-archived teachers eligible for at least one included group (§3.3). */
  pool: number[];
  /** Weekly minutes per included group. */
  minutes: number[];
  /** Teacher-typed conflicts of one time (cached per time and teacher). */
  teacherConflicts: (teacherId: string, time: DraftTime) => Conflict[];
  checks: number;
};

const timeSignature = (t: DraftTime) =>
  `${t.weekday}|${t.startMinute}|${t.endMinute}|${t.validFrom ?? ""}|${t.validUntil ?? ""}`;

/** Rule-3 reasons from the teacher-typed conflicts of one time. */
export function rule3Reasons(
  time: DraftTime,
  conflicts: readonly Conflict[],
): TeacherReason[] {
  const out: TeacherReason[] = [];
  for (const c of conflicts) {
    if (c.type === "TEACHER_UNAVAILABLE_WEEKLY") {
      out.push({
        code: "UNAVAILABLE_WEEKLY",
        params: {
          weekday: time.weekday,
          time: c.params.time ?? "",
          allDay: c.params.allDay ?? "no",
        },
        refs: c.refs,
      });
    }
  }
  for (const c of conflicts) {
    if (c.type === "TEACHER_DOUBLE_BOOKED") {
      out.push({
        code: "BUSY",
        params: {
          weekday: time.weekday,
          otherGroup: c.params.otherGroup ?? "",
          otherTime: c.params.otherTime ?? "",
          dateCount: c.params.dateCount ?? 0,
          firstDate: c.params.firstDate ?? "",
        },
        refs: c.refs,
      });
    }
  }
  return out;
}

export function computeEligibility(prepared: Prepared): Eligibility {
  const groups = includedGroups(prepared);
  const teachers = prepared.teachers;
  const { term, fixedCalendar } = prepared;
  const cache = new Map<string, Conflict[]>();
  let checks = 0;
  const teacherConflicts = (teacherId: string, time: DraftTime) => {
    const key = `${teacherId}|${timeSignature(time)}`;
    let conflicts = cache.get(key);
    if (!conflicts) {
      checks++;
      const slot = timeAsSlot(time, term.id, teacherId);
      conflicts = checkSlot(fixedCalendar, {
        ...slot,
        id: undefined,
        roomId: null,
      }).filter((c) => TEACHER_TYPED.has(c.type));
      cache.set(key, conflicts);
    }
    return conflicts;
  };

  const eligible: number[][] = [];
  const staticReasons: Map<number, TeacherReason[]>[] = [];
  const onDate: Map<number, Conflict[]>[] = [];
  const inPool = new Set<number>();
  for (const group of groups) {
    const e: number[] = [];
    const reasons = new Map<number, TeacherReason[]>();
    const dated = new Map<number, Conflict[]>();
    teachers.forEach((teacher, t) => {
      if (!teacher.levelIds.includes(group.levelId)) return;
      const list: TeacherReason[] = teacher.archived
        ? [{ code: "ARCHIVED", params: {}, refs: { teacherId: teacher.id } }]
        : [];
      const oneOff: Conflict[] = [];
      for (const time of group.times) {
        const conflicts = teacherConflicts(teacher.id, time);
        list.push(...rule3Reasons(time, conflicts));
        oneOff.push(
          ...conflicts.filter((c) => c.type === "TEACHER_UNAVAILABLE_ON_DATE"),
        );
      }
      const blocked = list.length > 0;
      // Weekly unavailability first, then lessons, as §4.5 orders them.
      list.sort(
        (a, b) => reasonOrder.indexOf(a.code) - reasonOrder.indexOf(b.code),
      );
      if (blocked) {
        reasons.set(t, list);
      } else {
        e.push(t);
        inPool.add(t);
        if (oneOff.length > 0) dated.set(t, oneOff);
      }
    });
    eligible.push(e);
    staticReasons.push(reasons);
    onDate.push(dated);
  }

  // Overlap graph: same weekday, intersecting minutes, a shared date.
  const holidays = holidaysOfTerm(prepared.fixedContext.holidays, term.id);
  type Entry = { g: number; i: number; time: DraftTime; dates: Set<IsoDate> };
  const byWeekday = new Map<number, Entry[]>();
  groups.forEach((group, g) =>
    group.times.forEach((time, i) => {
      const dates = new Set(slotOccurrenceDates(time, term, holidays));
      const list = byWeekday.get(time.weekday) ?? [];
      list.push({ g, i, time, dates });
      byWeekday.set(time.weekday, list);
    }),
  );
  const overlaps = groups.map(() => new Set<number>());
  const overlapTimes = new Map<string, [number, number][]>();
  for (const entries of byWeekday.values()) {
    for (let a = 0; a < entries.length; a++) {
      for (let b = a + 1; b < entries.length; b++) {
        const x = entries[a];
        const y = entries[b];
        if (x.g === y.g) continue;
        if (!(
          x.time.startMinute < y.time.endMinute &&
          y.time.startMinute < x.time.endMinute
        )) {
          continue;
        }
        const [small, large] =
          x.dates.size <= y.dates.size
            ? [x.dates, y.dates]
            : [y.dates, x.dates];
        let shared = false;
        for (const date of small) {
          if (large.has(date)) {
            shared = true;
            break;
          }
        }
        if (!shared) continue;
        overlaps[x.g].add(y.g);
        overlaps[y.g].add(x.g);
        const [lo, hi] = x.g < y.g ? [x, y] : [y, x];
        const key = `${lo.g}|${hi.g}`;
        const list = overlapTimes.get(key) ?? [];
        list.push([lo.i, hi.i]);
        overlapTimes.set(key, list);
      }
    }
  }

  return {
    groups,
    teachers,
    eligible,
    staticReasons,
    onDate,
    overlaps,
    overlapTimes,
    pool: [...inPool].sort((a, b) => a - b),
    minutes: groups.map((g) => g.minutes),
    teacherConflicts,
    get checks() {
      return checks;
    },
  };
}

export const reasonOrder: readonly TeacherReason["code"][] = [
  "ARCHIVED",
  "UNAVAILABLE_WEEKLY",
  "BUSY",
  "TEACHING_IN_DRAFT",
  "OVER_MAX_HOURS",
];
