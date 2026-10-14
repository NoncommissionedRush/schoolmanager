import {
  compareStrings,
  generateLessonOccurrences,
  isHoliday,
  type LessonOccurrence,
  occurrenceOf,
} from "./generate-lessons";
import { addDays, type IsoDate } from "./time";
import type { HolidayInfo, LessonInfo, SlotInfo, TermInfo } from "./types";

/** A stored lesson plus whether anything else points at it. */
export type ExistingLesson = LessonInfo & {
  /**
   * Attendance, a lesson log, homework, teacher notes, absence reports,
   * replacements or makeup credits reference this lesson.
   */
  hasDependents: boolean;
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
 *   cancelled otherwise, so attendance, absences, homework, notes and manual
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
