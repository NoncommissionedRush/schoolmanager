// Substitute teachers: which lessons can get one, who is eligible, how
// candidates are ranked, and which lessons need cover
// (docs/architecture/phase5-rules.md §3). Pure and deterministic like the
// rest of the scheduling module: plain data in, sorted plain data out, the
// caller passes `now`. Built on `checkLesson`, so a substitute is checked
// exactly as the conflict checker checks any effective teacher.

import type { ConflictParams, ConflictRefs } from "./conflict-types";
import {
  type Calendar,
  checkLesson,
  TEACHER_CONFLICT_TYPES,
} from "./conflicts";
import { teacherConflictReasons } from "./teacher-reasons";
import {
  addDays,
  isoWeekday,
  type IsoDate,
  toZonedDateTime,
  zonedTimeToUtc,
} from "./time";
import type { LessonInfo } from "./types";

/** A substitute can be recorded up to this many days after the lesson ended. */
export const SUBSTITUTE_RECORD_DAYS = 7;
/** The admin's _Needs cover_ tab looks this far ahead (8 weeks). */
export const NEEDS_COVER_DAYS = 56;
/** `sameDay`: another lesson ends or starts within this many minutes. */
export const SAME_DAY_GAP_MINUTES = 90;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** §3.2: reasons a lesson can't get (or lose) a substitute. */
export type SubstituteLessonReasonCode =
  "LESSON_CANCELLED" | "TERM_NOT_PUBLISHED" | "TOO_LATE_TO_RECORD";

/** §3.3: reasons a teacher can't, or shouldn't, cover a lesson. */
export type SubstituteReasonCode =
  | "IS_REGULAR_TEACHER"
  | "IS_CURRENT"
  | "ARCHIVED"
  | "BUSY"
  | "UNAVAILABLE_WEEKLY"
  | "UNAVAILABLE_ON_DATE"
  | "LEVEL_NOT_TAUGHT"
  | "OVER_MAX_HOURS";

export type SubstituteSeverity = "refused" | "blocking" | "overridable";

export const SUBSTITUTE_SEVERITY: Readonly<
  Record<SubstituteReasonCode, SubstituteSeverity>
> = {
  IS_REGULAR_TEACHER: "refused",
  IS_CURRENT: "refused",
  ARCHIVED: "refused",
  BUSY: "blocking",
  UNAVAILABLE_WEEKLY: "overridable",
  UNAVAILABLE_ON_DATE: "overridable",
  LEVEL_NOT_TAUGHT: "overridable",
  OVER_MAX_HOURS: "overridable",
};

/** Same shape as the generator's `TeacherReason`, plus severity and key. */
export type SubstituteReason = {
  code: SubstituteReasonCode;
  severity: SubstituteSeverity;
  /** What the admin acknowledges for an overridable reason. */
  key: string;
  params: ConflictParams;
  refs: ConflictRefs;
};

/** A teacher as a substitute candidate. */
export type SubstituteTeacher = {
  /** `TeacherProfile.id`. */
  id: string;
  name: string;
  /** `User.deletedAt` set, or no `TEACHER` membership any more. */
  archived: boolean;
  maxMinutesPerWeek: number | null;
};

/** Acknowledgement key of an overridable substitute reason (§3.3). */
export const substituteKey = (teacherId: string, code: string) =>
  `sub:${teacherId}|${code}`;

const effectiveTeacherOf = (
  lesson: Pick<LessonInfo, "teacherId" | "substituteTeacherId">,
) => lesson.substituteTeacherId ?? lesson.teacherId;

/** The lesson's length in minutes. */
export const lessonMinutes = (
  lesson: Pick<LessonInfo, "startsAt" | "endsAt">,
) =>
  Math.round((lesson.endsAt.getTime() - lesson.startsAt.getTime()) / MINUTE_MS);

/**
 * §3.2: whether a lesson can get, change or lose a substitute. Every reason
 * that applies, in table order.
 */
export function substituteLessonReasons(
  lesson: Pick<LessonInfo, "status" | "endsAt">,
  { published, now }: { published: boolean; now: Date },
): SubstituteLessonReasonCode[] {
  const out: SubstituteLessonReasonCode[] = [];
  if (lesson.status === "CANCELLED") out.push("LESSON_CANCELLED");
  if (!published) out.push("TERM_NOT_PUBLISHED");
  if (
    now.getTime() - lesson.endsAt.getTime() >
    SUBSTITUTE_RECORD_DAYS * DAY_MS
  ) {
    out.push("TOO_LATE_TO_RECORD");
  }
  return out;
}

/** Whether the lesson has started / ended at `now` (§3.5, notifications). */
export function lessonPhase(
  lesson: Pick<LessonInfo, "startsAt" | "endsAt">,
  now: Date,
): "upcoming" | "started" | "ended" {
  if (lesson.endsAt.getTime() <= now.getTime()) return "ended";
  if (lesson.startsAt.getTime() <= now.getTime()) return "started";
  return "upcoming";
}

/**
 * The ISO week (Monday 00:00 to the next Monday 00:00, school time) that
 * contains `instant`.
 */
export function isoWeekOf(
  instant: Date,
  timeZone: string,
): { from: Date; to: Date } {
  const { date } = toZonedDateTime(instant, timeZone);
  const monday = addDays(date, 1 - isoWeekday(date));
  return {
    from: zonedTimeToUtc(monday, 0, timeZone),
    to: zonedTimeToUtc(addDays(monday, 7), 0, timeZone),
  };
}

/**
 * §3.4, the one definition of "minutes a teacher teaches": the length of
 * every non-cancelled lesson whose effective teacher is `teacherId` and
 * that starts in `[from, to)`, except `excludeLessonId`.
 */
export function teachingMinutes(
  lessons: readonly LessonInfo[],
  teacherId: string,
  range: { from: Date; to: Date },
  excludeLessonId?: string,
): number {
  let total = 0;
  for (const lesson of lessons) {
    if (lesson.id === excludeLessonId || lesson.status === "CANCELLED")
      continue;
    if (effectiveTeacherOf(lesson) !== teacherId) continue;
    const start = lesson.startsAt.getTime();
    if (start < range.from.getTime() || start >= range.to.getTime()) continue;
    total += lessonMinutes(lesson);
  }
  return total;
}

/** Teacher-typed conflicts of `lesson` taught by `teacherId` (or regular). */
function teacherConflicts(
  calendar: Calendar,
  lesson: LessonInfo,
  substituteTeacherId: string | null,
) {
  return checkLesson(calendar, { ...lesson, substituteTeacherId }).filter((c) =>
    TEACHER_CONFLICT_TYPES.includes(c.type),
  );
}

/**
 * §3.3: every reason teacher `teacher` can't, or shouldn't, cover `lesson`.
 * Rules 4–6 are `checkLesson` with the candidate as substitute, keeping
 * only teacher-typed conflicts (a lesson's own room or holiday conflicts
 * are not the substitute's problem). Rule 7 is stricter than the editor: a
 * teacher with no level rows doesn't teach the level either.
 */
export function checkSubstitute(
  calendar: Calendar,
  lesson: LessonInfo,
  teacher: SubstituteTeacher,
): SubstituteReason[] {
  const out: SubstituteReason[] = [];
  const add = (
    code: SubstituteReasonCode,
    params: ConflictParams = {},
    refs: ConflictRefs = {},
  ) =>
    out.push({
      code,
      severity: SUBSTITUTE_SEVERITY[code],
      key: substituteKey(teacher.id, code),
      params,
      refs,
    });

  if (teacher.id === lesson.teacherId) add("IS_REGULAR_TEACHER");
  if (teacher.id === lesson.substituteTeacherId) add("IS_CURRENT");
  if (teacher.archived) add("ARCHIVED");
  if (out.length > 0) return out;

  const { timeZone } = calendar.context.school;
  const weekday = isoWeekday(toZonedDateTime(lesson.startsAt, timeZone).date);
  const conflicts = teacherConflicts(calendar, lesson, teacher.id);
  const reasons = teacherConflictReasons(weekday, conflicts, { onDate: true });
  for (const code of [
    "BUSY",
    "UNAVAILABLE_WEEKLY",
    "UNAVAILABLE_ON_DATE",
  ] as const) {
    for (const r of reasons.filter((x) => x.code === code)) {
      add(code, r.params, r.refs);
    }
  }

  const group = calendar.groups.get(lesson.groupId);
  const levelId = group?.levelId ?? null;
  if (levelId && !calendar.teacherLevels?.get(teacher.id)?.has(levelId)) {
    const levels = calendar.context.levels ?? [];
    const taught = [...(calendar.teacherLevels?.get(teacher.id) ?? [])]
      .map((id) => levels.find((l) => l.id === id)?.name ?? id)
      .sort();
    add(
      "LEVEL_NOT_TAUGHT",
      {
        level: levels.find((l) => l.id === levelId)?.name ?? levelId,
        levels: taught.join(", "),
      },
      { teacherId: teacher.id, groupId: lesson.groupId },
    );
  }

  if (teacher.maxMinutesPerWeek !== null) {
    const week = isoWeekOf(lesson.startsAt, timeZone);
    const before = teachingMinutes(
      calendar.context.lessons,
      teacher.id,
      week,
      lesson.id,
    );
    const after = before + lessonMinutes(lesson);
    if (after > teacher.maxMinutesPerWeek) {
      add("OVER_MAX_HOURS", {
        current: before,
        with: after,
        max: teacher.maxMinutesPerWeek,
      });
    }
  }
  return out;
}

export type SubstituteBand = "SUGGESTED" | "WITH_WARNING" | "NOT_POSSIBLE";
export type SubstituteHint = "KNOWS_GROUP" | "SAME_DAY" | "FEWEST_HOURS";

export type SubstituteFacts = {
  knowsGroup: boolean;
  sameDay: boolean;
  weekMinutesBefore: number;
  weekMinutesAfter: number;
  maxMinutes: number | null;
  termSubstitutions: number;
};

export type SubstituteSuggestion = {
  teacherId: string;
  name: string;
  band: SubstituteBand;
  /** 1… within `SUGGESTED`; null in the other bands. */
  rank: number | null;
  /** The lesson's current substitute (listed first, can't be assigned again). */
  current: boolean;
  reasons: SubstituteReason[];
  hints: SubstituteHint[];
  facts: SubstituteFacts;
};

export type SubstituteHistory = {
  /**
   * Lessons of the lesson's group in its term and the previous one, for
   * `knowsGroup`. Lessons in `calendar.context.lessons` count too.
   */
  groupLessons: readonly LessonInfo[];
};

const bandOf = (reasons: readonly SubstituteReason[]): SubstituteBand =>
  reasons.some((r) => r.severity !== "overridable")
    ? "NOT_POSSIBLE"
    : reasons.length > 0
      ? "WITH_WARNING"
      : "SUGGESTED";

const BAND_ORDER: Record<SubstituteBand, number> = {
  SUGGESTED: 0,
  WITH_WARNING: 1,
  NOT_POSSIBLE: 2,
};

/** Rank facts of one candidate (§3.7). */
function factsOf(
  calendar: Calendar,
  lesson: LessonInfo,
  teacher: SubstituteTeacher,
  history: SubstituteHistory,
  now: Date,
): SubstituteFacts {
  const { timeZone } = calendar.context.school;
  const lessons = calendar.context.lessons;
  const week = isoWeekOf(lesson.startsAt, timeZone);
  const before = teachingMinutes(lessons, teacher.id, week, lesson.id);
  const seen = new Set<string>();
  let knowsGroup = false;
  for (const l of [...lessons, ...history.groupLessons]) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    if (
      l.groupId === lesson.groupId &&
      l.status !== "CANCELLED" &&
      l.endsAt.getTime() <= now.getTime() &&
      effectiveTeacherOf(l) === teacher.id
    ) {
      knowsGroup = true;
      break;
    }
  }
  const day = toZonedDateTime(lesson.startsAt, timeZone).date;
  const gap = SAME_DAY_GAP_MINUTES * MINUTE_MS;
  const sameDay = lessons.some(
    (l) =>
      l.id !== lesson.id &&
      l.status !== "CANCELLED" &&
      effectiveTeacherOf(l) === teacher.id &&
      toZonedDateTime(l.startsAt, timeZone).date === day &&
      ((lesson.startsAt.getTime() - l.endsAt.getTime() >= 0 &&
        lesson.startsAt.getTime() - l.endsAt.getTime() <= gap) ||
        (l.startsAt.getTime() - lesson.endsAt.getTime() >= 0 &&
          l.startsAt.getTime() - lesson.endsAt.getTime() <= gap)),
  );
  const termSubstitutions = lessons.filter(
    (l) =>
      l.termId === lesson.termId &&
      l.id !== lesson.id &&
      l.status !== "CANCELLED" &&
      l.substituteTeacherId === teacher.id,
  ).length;
  return {
    knowsGroup,
    sameDay,
    weekMinutesBefore: before,
    weekMinutesAfter: before + lessonMinutes(lesson),
    maxMinutes: teacher.maxMinutesPerWeek,
    termSubstitutions,
  };
}

const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * §3.7: every non-archived teacher except the regular one, with reasons,
 * band, rank and hints, the current substitute first. Sorted by band
 * (with-warning by fewest reasons), then `knowsGroup`, `sameDay`, fewer
 * `weekMinutesAfter`, fewer `termSubstitutions`, name and id. Independent
 * of the order of `teachers`.
 */
export function suggestSubstitutes(
  calendar: Calendar,
  lesson: LessonInfo,
  teachers: readonly SubstituteTeacher[],
  history: SubstituteHistory,
  now: Date,
): SubstituteSuggestion[] {
  const entries: SubstituteSuggestion[] = [];
  for (const teacher of teachers) {
    if (teacher.archived || teacher.id === lesson.teacherId) continue;
    const current = teacher.id === lesson.substituteTeacherId;
    // The current substitute is checked as if the lesson had none, so the
    // admin sees whether they are still fine.
    const reasons = current
      ? checkSubstitute(
          calendar,
          { ...lesson, substituteTeacherId: null },
          teacher,
        )
      : checkSubstitute(calendar, lesson, teacher);
    entries.push({
      teacherId: teacher.id,
      name: teacher.name,
      band: bandOf(reasons),
      rank: null,
      current,
      reasons,
      hints: [],
      facts: factsOf(calendar, lesson, teacher, history, now),
    });
  }
  entries.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.band !== b.band) return BAND_ORDER[a.band] - BAND_ORDER[b.band];
    if (a.band === "WITH_WARNING" && a.reasons.length !== b.reasons.length) {
      return a.reasons.length - b.reasons.length;
    }
    if (a.facts.knowsGroup !== b.facts.knowsGroup)
      return a.facts.knowsGroup ? -1 : 1;
    if (a.facts.sameDay !== b.facts.sameDay) return a.facts.sameDay ? -1 : 1;
    if (a.facts.weekMinutesAfter !== b.facts.weekMinutesAfter) {
      return a.facts.weekMinutesAfter - b.facts.weekMinutesAfter;
    }
    if (a.facts.termSubstitutions !== b.facts.termSubstitutions) {
      return a.facts.termSubstitutions - b.facts.termSubstitutions;
    }
    return (
      compareStrings(a.name, b.name) || compareStrings(a.teacherId, b.teacherId)
    );
  });
  const suggested = entries.filter((e) => e.band === "SUGGESTED" && !e.current);
  const fewest = Math.min(...suggested.map((e) => e.facts.weekMinutesAfter));
  suggested.forEach((entry, i) => {
    entry.rank = i + 1;
    const hints: SubstituteHint[] = [];
    if (entry.facts.knowsGroup) hints.push("KNOWS_GROUP");
    if (entry.facts.sameDay) hints.push("SAME_DAY");
    if (entry.facts.weekMinutesAfter === fewest) hints.push("FEWEST_HOURS");
    entry.hints = hints.slice(0, 2);
  });
  return entries;
}

/** §3.5 Remove: the regular teacher checked as the one teaching again. */
export type RemoveCheck = {
  /** Removing is refused (`refusal` says why). */
  refused: boolean;
  /**
   * `REGULAR_TEACHER_ARCHIVED`: they no longer teach (§3.3 rule 3);
   * `REGULAR_TEACHER_BUSY`: they teach another lesson then.
   */
  refusal: "REGULAR_TEACHER_ARCHIVED" | "REGULAR_TEACHER_BUSY" | null;
  /** The other lesson's group when busy, for the dialog. */
  otherGroup: string | null;
  /** Other teacher-typed conflicts of the regular teacher: overridable. */
  reasons: SubstituteReason[];
};

export function checkSubstituteRemoval(
  calendar: Calendar,
  lesson: LessonInfo,
  { regularArchived = false }: { regularArchived?: boolean } = {},
): RemoveCheck {
  if (regularArchived) {
    return {
      refused: true,
      refusal: "REGULAR_TEACHER_ARCHIVED",
      otherGroup: null,
      reasons: [],
    };
  }
  const { timeZone } = calendar.context.school;
  const weekday = isoWeekday(toZonedDateTime(lesson.startsAt, timeZone).date);
  const conflicts = teacherConflicts(calendar, lesson, null);
  const reasons: SubstituteReason[] = teacherConflictReasons(
    weekday,
    conflicts,
    {
      onDate: true,
    },
  ).map((r) => ({
    ...r,
    severity: SUBSTITUTE_SEVERITY[r.code],
    key: substituteKey(lesson.teacherId, r.code),
  }));
  for (const c of conflicts) {
    if (c.type === "TEACHER_LEVEL_NOT_TAUGHT") {
      reasons.push({
        code: "LEVEL_NOT_TAUGHT",
        severity: "overridable",
        key: substituteKey(lesson.teacherId, "LEVEL_NOT_TAUGHT"),
        params: { level: c.params.level ?? "", levels: "" },
        refs: c.refs,
      });
    }
  }
  const busy = reasons.find((r) => r.code === "BUSY");
  return {
    refused: busy !== undefined,
    refusal: busy ? "REGULAR_TEACHER_BUSY" : null,
    otherGroup: busy ? String(busy.params.otherGroup ?? "") : null,
    reasons: reasons.filter((r) => r.code !== "BUSY"),
  };
}

export type NeedsCoverReason =
  "UNAVAILABLE_ON_DATE" | "DOUBLE_BOOKED" | "ARCHIVED";

export type NeedsCover = {
  lessonId: string;
  who: "REGULAR" | "SUBSTITUTE";
  reasons: NeedsCoverReason[];
  /** The clashing lesson's group, for "Teaching {otherGroup}". */
  otherGroup: string | null;
};

/**
 * §3.7 Needs cover: not-cancelled lessons starting in `[from, to)` that
 * haven't started at `now` (default `from`), whose effective teacher is away that day (one-off), teaching another lesson
 * then, or archived. Weekly unavailability is left out on purpose (it was
 * acknowledged when the slot was planned). Soonest first.
 */
export function lessonsNeedingCover(
  calendar: Calendar,
  from: Date,
  to: Date,
  archivedTeacherIds: ReadonlySet<string>,
  now: Date = from,
): NeedsCover[] {
  const out: (NeedsCover & { startsAt: number })[] = [];
  for (const lesson of calendar.context.lessons) {
    if (lesson.status === "CANCELLED") continue;
    const start = lesson.startsAt.getTime();
    if (start < from.getTime() || start >= to.getTime()) continue;
    // Not started yet.
    if (start <= now.getTime()) continue;
    const effective = effectiveTeacherOf(lesson);
    const reasons: NeedsCoverReason[] = [];
    let otherGroup: string | null = null;
    const conflicts = checkLesson(calendar, lesson);
    if (conflicts.some((c) => c.type === "TEACHER_UNAVAILABLE_ON_DATE")) {
      reasons.push("UNAVAILABLE_ON_DATE");
    }
    const busy = conflicts.find((c) => c.type === "TEACHER_DOUBLE_BOOKED");
    if (busy) {
      reasons.push("DOUBLE_BOOKED");
      otherGroup = String(busy.params.otherGroup ?? "");
    }
    if (archivedTeacherIds.has(effective)) reasons.push("ARCHIVED");
    if (reasons.length === 0) continue;
    out.push({
      lessonId: lesson.id,
      who: lesson.substituteTeacherId ? "SUBSTITUTE" : "REGULAR",
      reasons,
      otherGroup,
      startsAt: start,
    });
  }
  out.sort(
    (a, b) => a.startsAt - b.startsAt || compareStrings(a.lessonId, b.lessonId),
  );
  return out.map(({ lessonId, who, reasons, otherGroup }) => ({
    lessonId,
    who,
    reasons,
    otherGroup,
  }));
}

/** Local date of an instant, for grouping lists by day. */
export const localDateOf = (instant: Date, timeZone: string): IsoDate =>
  toZonedDateTime(instant, timeZone).date;
