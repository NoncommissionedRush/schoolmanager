import {
  compareStrings,
  generateLessonOccurrences,
  isHoliday,
  type LessonOccurrence,
  occurrenceOf,
} from "./generate-lessons";
import { addDays, type IsoDate, isoWeekday, toZonedDateTime } from "./time";
import type { HolidayInfo, LessonInfo, SlotInfo, TermInfo } from "./types";

/** A stored lesson plus whether anything else points at it. */
export type ExistingLesson = LessonInfo & {
  /**
   * A lesson log (with homework), teacher notes, absence reports,
   * replacements or makeup credits reference this lesson.
   */
  hasDependents: boolean;
  /** `Lesson.cancelReason`; needed by `planSlotCarryOver`. */
  cancelReason?: string | null;
};

/** Stored in `Lesson.cancelReason`; the UI translates `scheduling.cancelReasons.<code>`. */
export type CancelReason = "HOLIDAY" | "TIMETABLE_CHANGED";

export type LessonSyncPlan = {
  /** Occurrences that should exist but have no lesson row yet. */
  create: LessonOccurrence[];
  /** Untouched SCHEDULED lessons that are no longer wanted: delete them. */
  remove: string[];
  /**
   * Lessons that are no longer wanted but carry history or a manual change:
   * set to CANCELLED (with `reason`) instead of deleting.
   */
  cancel: { id: string; reason: CancelReason }[];
};

export type LessonSyncInput = {
  term: TermInfo;
  /** All slots of the term, ended ones included. */
  slots: readonly SlotInfo[];
  /** The term's holidays and the school-wide ones. */
  holidays: readonly HolidayInfo[];
  /** All generated lessons of the term (any status). */
  lessons: readonly ExistingLesson[];
  timeZone: string;
  /** First date to reconcile, usually today. Earlier lessons are never touched. */
  from: IsoDate;
  /**
   * Lessons starting at or before this instant are never touched or created,
   * so a lesson that already took place today is kept.
   */
  now?: Date;
};

/**
 * Whether `lesson` is exactly what its slot generates and nothing refers to
 * it, so it can be deleted and re-created without losing anything.
 */
export function isUntouched(
  lesson: ExistingLesson,
  slot: SlotInfo | undefined,
  timeZone: string,
): boolean {
  if (
    !slot ||
    !lesson.occurrenceDate ||
    lesson.status !== "SCHEDULED" ||
    lesson.hasDependents ||
    lesson.substituteTeacherId !== null
  ) {
    return false;
  }
  const expected = occurrenceOf(slot, lesson.occurrenceDate, timeZone);
  return (
    lesson.groupId === expected.groupId &&
    lesson.teacherId === expected.teacherId &&
    lesson.roomId === expected.roomId &&
    lesson.startsAt.getTime() === expected.startsAt.getTime() &&
    lesson.endsAt.getTime() === expected.endsAt.getTime()
  );
}

/**
 * Reconciles a term's generated lessons with its slots and holidays from
 * `from` onwards. Pure and idempotent: applying the plan and planning again
 * yields an empty plan.
 *
 * - A slot occurrence (slot in effect, not a holiday) without a lesson row
 *   gets one. A cancelled lesson for that slot and date counts as a row:
 *   a cancellation is never undone automatically.
 * - A SCHEDULED lesson whose occurrence is no longer wanted (slot ended or
 *   moved, holiday added, term shortened) is deleted when untouched and
 *   cancelled otherwise, so logs, homework, absences, notes and manual
 *   moves or substitutions are never lost silently.
 * - Lessons before `from` or `now`, and COMPLETED or CANCELLED lessons, are
 *   left alone.
 * - A wanted lesson that was edited by hand (moved, substitute) stays as is.
 */
export function planLessonSync({
  term,
  slots,
  holidays,
  lessons,
  timeZone,
  from,
  now,
}: LessonSyncInput): LessonSyncPlan {
  const started = (startsAt: Date) => now !== undefined && startsAt <= now;
  const wanted = generateLessonOccurrences({
    slots,
    term,
    holidays,
    timeZone,
    range: { startDate: from },
  });
  const wantedKeys = new Set(
    wanted.map((o) => `${o.timetableSlotId}|${o.date}`),
  );
  const existingKeys = new Set(
    lessons
      .filter((l) => l.timetableSlotId && l.occurrenceDate)
      .map((l) => `${l.timetableSlotId}|${l.occurrenceDate}`),
  );
  const slotsById = new Map(slots.map((slot) => [slot.id, slot]));

  const create = wanted.filter(
    (o) =>
      !existingKeys.has(`${o.timetableSlotId}|${o.date}`) &&
      !started(o.startsAt),
  );
  const remove: string[] = [];
  const cancel: LessonSyncPlan["cancel"] = [];
  const sorted = [...lessons].sort(
    (a, b) =>
      compareStrings(a.occurrenceDate ?? "", b.occurrenceDate ?? "") ||
      compareStrings(a.id, b.id),
  );
  for (const lesson of sorted) {
    const { timetableSlotId: slotId, occurrenceDate: date } = lesson;
    if (
      !slotId ||
      !date ||
      date < from ||
      lesson.status !== "SCHEDULED" ||
      started(lesson.startsAt)
    ) {
      continue;
    }
    if (wantedKeys.has(`${slotId}|${date}`)) continue;
    if (isUntouched(lesson, slotsById.get(slotId), timeZone)) {
      remove.push(lesson.id);
    } else {
      cancel.push({
        id: lesson.id,
        reason: isHoliday(date, holidays) ? "HOLIDAY" : "TIMETABLE_CHANGED",
      });
    }
  }
  return { create, remove, cancel };
}

export function isEmptyPlan(plan: LessonSyncPlan): boolean {
  return (
    plan.create.length === 0 &&
    plan.remove.length === 0 &&
    plan.cancel.length === 0
  );
}

// ---------------------------------------------------------------------------
// Slot lifecycle
// ---------------------------------------------------------------------------

/** The template fields an admin can change on a slot. */
export type SlotChange = Partial<
  Pick<
    SlotInfo,
    "groupId" | "teacherId" | "roomId" | "weekday" | "startMinute" | "endMinute"
  >
>;

export type SlotEditPlan =
  /** The slot has no lessons: rewrite it in place. */
  | { kind: "update"; slot: SlotInfo }
  /**
   * The slot has lessons: end it the day before `effectiveFrom` and continue
   * with a new slot from that date, so past lessons keep pointing at the
   * template they were generated from.
   */
  | { kind: "split"; ended: SlotInfo; next: Omit<SlotInfo, "id"> };

/**
 * How to apply `change` to `slot` from `effectiveFrom` on (null = the whole
 * slot, only possible while it has no lessons). `remainingLessons` is how many
 * lesson rows still belong to the slot after its lessons from `effectiveFrom`
 * on were reconciled (see docs/architecture/scheduling.md).
 */
export function planSlotEdit(
  slot: SlotInfo,
  change: SlotChange,
  effectiveFrom: IsoDate | null,
  remainingLessons: number,
): SlotEditPlan {
  if (remainingLessons === 0) {
    const validFrom =
      effectiveFrom && (!slot.validFrom || slot.validFrom < effectiveFrom)
        ? effectiveFrom
        : slot.validFrom;
    return { kind: "update", slot: { ...slot, ...change, validFrom } };
  }
  if (!effectiveFrom) {
    throw new Error("A slot with lessons can only change from a given date");
  }
  // A slot that starts later keeps its start date.
  const nextFrom =
    slot.validFrom && slot.validFrom > effectiveFrom
      ? slot.validFrom
      : effectiveFrom;
  const next: Omit<SlotInfo, "id"> & { id?: string } = {
    ...slot,
    ...change,
    validFrom: nextFrom,
  };
  delete next.id;
  return {
    kind: "split",
    ended: { ...slot, validUntil: addDays(nextFrom, -1) },
    next,
  };
}

// ---------------------------------------------------------------------------
// Slot splits: what follows the slot to its successor lessons
// ---------------------------------------------------------------------------

/**
 * Cancel reasons of a 1-on-1 the student or an admin took out of the
 * timetable (replacements.md §3, §7). In a split, the successor lesson is
 * created already cancelled with the same reason.
 */
export const CARRIED_CANCEL_REASONS = ["STUDENT_CANCELLED", "RESCHEDULED"];

/** One old-slot lesson and the new slot's occurrence that takes its place. */
export type CarryOver = {
  fromLessonId: string;
  toSlotId: string;
  toDate: IsoDate;
  /**
   * Set when `fromLessonId` is a cancelled 1-on-1: its successor is created
   * cancelled with this reason, so the student never gets the week back.
   */
  cancelSuccessor: string | null;
};

export type SlotCarryOverInput = {
  /** The old slot as it ends (`validUntil` = the day before the split). */
  ended: SlotInfo;
  /** The new slot continuing it. */
  next: SlotInfo;
  term: TermInfo;
  holidays: readonly HolidayInfo[];
  /** The old slot's generated lessons from `from` on, any status. */
  lessons: readonly ExistingLesson[];
  /** Lessons the split cancels (`planLessonSync(...).cancel` of `ended`). */
  cancelling: readonly string[];
  timeZone: string;
  from: IsoDate;
  now?: Date;
};

/** Monday of the ISO week `date` is in. */
const weekOf = (date: IsoDate) => addDays(date, 1 - isoWeekday(date));

/**
 * Pairs each old-slot lesson whose absences, cancellation or replacement
 * bookings must survive a slot split with its **successor**: the new slot's
 * occurrence in the same ISO week (replacements.md §5 _Slot splits_).
 * Candidates are the lessons the split cancels (they carry history) and
 * 1-on-1s already cancelled by the student or rescheduled by an admin.
 * A lesson has no successor when the new slot doesn't occur that week
 * (a holiday, the slot ends, or the new weekday falls before `from`), when
 * the successor has already started, or when the split changes the group
 * (absences and bookings belong to the old group's lesson). Pure and
 * deterministic: sorted by date, then lesson id.
 */
export function planSlotCarryOver({
  ended,
  next,
  term,
  holidays,
  lessons,
  cancelling,
  timeZone,
  from,
  now,
}: SlotCarryOverInput): CarryOver[] {
  if (next.groupId !== ended.groupId) return [];
  const started = (startsAt: Date) => now !== undefined && startsAt <= now;
  const successors = new Map<IsoDate, IsoDate>();
  for (const o of generateLessonOccurrences({
    slots: [next],
    term,
    holidays,
    timeZone,
    range: { startDate: from },
  })) {
    if (!started(o.startsAt)) successors.set(weekOf(o.date), o.date);
  }
  const cancelled = new Set(cancelling);
  const out: CarryOver[] = [];
  const taken = new Set<IsoDate>();
  const sorted = [...lessons].sort(
    (a, b) =>
      compareStrings(a.occurrenceDate ?? "", b.occurrenceDate ?? "") ||
      compareStrings(a.id, b.id),
  );
  for (const lesson of sorted) {
    const date = lesson.occurrenceDate;
    if (
      lesson.timetableSlotId !== ended.id ||
      !date ||
      date < from ||
      started(lesson.startsAt)
    ) {
      continue;
    }
    const cancelSuccessor =
      lesson.status === "CANCELLED" &&
      lesson.cancelReason &&
      CARRIED_CANCEL_REASONS.includes(lesson.cancelReason)
        ? lesson.cancelReason
        : null;
    if (!cancelSuccessor && !cancelled.has(lesson.id)) continue;
    const toDate = successors.get(weekOf(date));
    // One lesson per week: a second candidate that week keeps its own.
    if (!toDate || taken.has(toDate)) continue;
    taken.add(toDate);
    out.push({
      fromLessonId: lesson.id,
      toSlotId: next.id,
      toDate,
      cancelSuccessor,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Teacher-only change of a group from a date (generator.md §5.6)
// ---------------------------------------------------------------------------

export type GroupTeacherChangeInput = {
  /** The group's slots in the term, ended ones included. */
  slots: readonly SlotInfo[];
  /**
   * Every lesson of those slots (any date and status) and the group's
   * ad-hoc lessons (`timetableSlotId` null) from `from` on.
   */
  lessons: readonly ExistingLesson[];
  /** The group's current teacher; null when its slots have different ones. */
  oldTeacherId: string | null;
  newTeacherId: string;
  /** First date with the new teacher. */
  from: IsoDate;
  /** Lessons starting at or before this instant keep their teacher. */
  now?: Date;
  timeZone: string;
};

export type GroupTeacherChangePlan = {
  /**
   * Per slot in effect on or after `from` with another teacher: `update`
   * (it starts on or after `from` and keeps no lesson of its own: change the
   * teacher in place) or `split` (end it the day before, continue with a
   * copy with the new teacher).
   */
  slots: (
    | { kind: "update"; slot: SlotInfo }
    | { kind: "split"; ended: SlotInfo; next: Omit<SlotInfo, "id"> }
  )[];
  /**
   * Lessons that move to the new slot of `fromSlotId` (the same slot for
   * `update`), same `occurrenceDate`, whatever their status. `setTeacher`:
   * SCHEDULED and not started, gets `teacherId` = the new teacher;
   * `clearSubstitute`: the substitute was the new teacher.
   */
  repoint: {
    lessonId: string;
    fromSlotId: string;
    setTeacher: boolean;
    clearSubstitute: boolean;
  }[];
  /** The group's ad-hoc lessons the old teacher was going to give. */
  adHoc: { lessonId: string; clearSubstitute: boolean }[];
  /**
   * Lessons with their own time or room (moved or re-roomed by hand, and
   * ad-hoc ones) that get the new teacher: check each with `checkLesson`.
   */
  checkLessons: string[];
};

/**
 * Gives a group a new teacher from `from` without touching its lessons'
 * time, room or students (generator.md §5.6). Every lesson of the group's
 * slots dated on or after `from` is re-pointed to the new
 * slot, so absences, bookings, credits, notes and cancellations stay on the
 * same row and `planLessonSync` creates no second occurrence for its date.
 * Nothing is cancelled or deleted, lessons before `from` are left alone,
 * and one already started (moved by hand to an earlier time) keeps its
 * teacher. Pure and deterministic: sorted by slot, then date, then id.
 */
export function planGroupTeacherChange({
  slots,
  lessons,
  oldTeacherId,
  newTeacherId,
  from,
  now,
  timeZone,
}: GroupTeacherChangeInput): GroupTeacherChangePlan {
  const started = (startsAt: Date) => now !== undefined && startsAt <= now;
  const plan: GroupTeacherChangePlan = {
    slots: [],
    repoint: [],
    adHoc: [],
    checkLessons: [],
  };
  const sortedLessons = [...lessons].sort(
    (a, b) =>
      compareStrings(a.occurrenceDate ?? "", b.occurrenceDate ?? "") ||
      a.startsAt.getTime() - b.startsAt.getTime() ||
      compareStrings(a.id, b.id),
  );
  const changing = [...slots]
    .filter(
      (slot) =>
        slot.teacherId !== newTeacherId &&
        (!slot.validUntil || slot.validUntil >= from),
    )
    .sort((a, b) => compareStrings(a.id, b.id));

  for (const slot of changing) {
    const own = sortedLessons.filter((l) => l.timetableSlotId === slot.id);
    // Every lesson dated from `from` moves, so no second occurrence is
    // created for its date; one moved by hand to a time that has started
    // keeps its teacher.
    const moving = own.filter(
      (l) => l.occurrenceDate !== null && l.occurrenceDate >= from,
    );
    const nextFrom =
      slot.validFrom && slot.validFrom > from ? slot.validFrom : from;
    const next = { ...slot, teacherId: newTeacherId, validFrom: nextFrom };
    if (nextFrom === slot.validFrom && moving.length === own.length) {
      plan.slots.push({ kind: "update", slot: next });
    } else {
      const copy: Omit<SlotInfo, "id"> & { id?: string } = { ...next };
      delete copy.id;
      plan.slots.push({
        kind: "split",
        ended: { ...slot, validUntil: addDays(nextFrom, -1) },
        next: copy,
      });
    }
    for (const lesson of moving) {
      const scheduled =
        lesson.status === "SCHEDULED" && !started(lesson.startsAt);
      plan.repoint.push({
        lessonId: lesson.id,
        fromSlotId: slot.id,
        setTeacher: scheduled,
        clearSubstitute:
          scheduled && lesson.substituteTeacherId === newTeacherId,
      });
      const expected = occurrenceOf(next, lesson.occurrenceDate!, timeZone);
      const ownTimeOrRoom =
        lesson.roomId !== expected.roomId ||
        lesson.startsAt.getTime() !== expected.startsAt.getTime() ||
        lesson.endsAt.getTime() !== expected.endsAt.getTime();
      if (scheduled && ownTimeOrRoom) plan.checkLessons.push(lesson.id);
    }
  }

  for (const lesson of sortedLessons) {
    if (
      lesson.timetableSlotId !== null ||
      lesson.status !== "SCHEDULED" ||
      oldTeacherId === null ||
      lesson.teacherId !== oldTeacherId ||
      started(lesson.startsAt) ||
      toZonedDateTime(lesson.startsAt, timeZone).date < from
    ) {
      continue;
    }
    plan.adHoc.push({
      lessonId: lesson.id,
      clearSubstitute: lesson.substituteTeacherId === newTeacherId,
    });
    plan.checkLessons.push(lesson.id);
  }
  return plan;
}

/**
 * `lessons` as they are after `plan`: re-pointed lessons carry the id
 * `slotIdOf` gives their new slot, SCHEDULED ones and the ad-hoc ones get
 * `newTeacherId`, and a substitute who is the new teacher is cleared. For
 * the would-be calendar that `checkLesson` runs on before anything is
 * written. Lessons the plan doesn't touch are returned as they are.
 */
export function applyGroupTeacherChange<
  L extends Pick<
    LessonInfo,
    "id" | "timetableSlotId" | "teacherId" | "substituteTeacherId"
  >,
>(
  lessons: readonly L[],
  plan: GroupTeacherChangePlan,
  newTeacherId: string,
  slotIdOf: (fromSlotId: string) => string,
): L[] {
  const repoint = new Map(plan.repoint.map((r) => [r.lessonId, r]));
  const adHoc = new Map(plan.adHoc.map((a) => [a.lessonId, a]));
  return lessons.map((l) => {
    const r = repoint.get(l.id);
    const a = adHoc.get(l.id);
    if (!r && !a) return l;
    const clear = r?.clearSubstitute || a?.clearSubstitute;
    return {
      ...l,
      timetableSlotId: r ? slotIdOf(r.fromSlotId) : l.timetableSlotId,
      teacherId: !r || r.setTeacher ? newTeacherId : l.teacherId,
      substituteTeacherId: clear ? null : l.substituteTeacherId,
    };
  });
}
