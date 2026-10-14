import type { IsoDate } from "./time";

/**
 * Every conflict the checker reports, in display order. Each type has a
 * fixed severity and an i18n message `scheduling.conflicts.<type>` in
 * messages/<locale>/scheduling.json; the table in
 * docs/architecture/scheduling.md lists the parameters of each message.
 */
export const CONFLICT_TYPES = [
  // Blocking: the slot or lesson cannot be saved, not even by an admin.
  "INVALID_TIME",
  "OUTSIDE_TERM",
  "GROUP_ARCHIVED",
  "ROOM_ARCHIVED",
  "TEACHER_DOUBLE_BOOKED",
  "ROOM_DOUBLE_BOOKED",
  "GROUP_DOUBLE_BOOKED",
  // Overridable: an admin may save anyway; the override is audited.
  "STUDENT_DOUBLE_BOOKED",
  "ONLINE_ROOM_SHARED",
  "ROOM_CAPACITY_EXCEEDED",
  "GROUP_OVER_CAPACITY",
  "ONE_ON_ONE_STUDENT_COUNT",
  "TEACHER_UNAVAILABLE_WEEKLY",
  "TEACHER_UNAVAILABLE_ON_DATE",
  "LESSON_ON_HOLIDAY",
  "OUTSIDE_SCHOOL_DAYS",
  "OUTSIDE_SCHOOL_HOURS",
  "NO_OCCURRENCES",
] as const;

export type ConflictType = (typeof CONFLICT_TYPES)[number];

/**
 * `blocking`: impossible or inconsistent (one person or room in two places,
 * a time that does not exist in the term). `overridable`: undesirable but
 * sometimes intended (a full room, a teacher who agreed to come in on their
 * day off); an admin can save after acknowledging it.
 */
export type Severity = "blocking" | "overridable";

export const CONFLICT_SEVERITY: Readonly<Record<ConflictType, Severity>> = {
  INVALID_TIME: "blocking",
  OUTSIDE_TERM: "blocking",
  GROUP_ARCHIVED: "blocking",
  ROOM_ARCHIVED: "blocking",
  TEACHER_DOUBLE_BOOKED: "blocking",
  ROOM_DOUBLE_BOOKED: "blocking",
  GROUP_DOUBLE_BOOKED: "blocking",
  STUDENT_DOUBLE_BOOKED: "overridable",
  ONLINE_ROOM_SHARED: "overridable",
  ROOM_CAPACITY_EXCEEDED: "overridable",
  GROUP_OVER_CAPACITY: "overridable",
  ONE_ON_ONE_STUDENT_COUNT: "overridable",
  TEACHER_UNAVAILABLE_WEEKLY: "overridable",
  TEACHER_UNAVAILABLE_ON_DATE: "overridable",
  LESSON_ON_HOLIDAY: "overridable",
  OUTSIDE_SCHOOL_DAYS: "overridable",
  OUTSIDE_SCHOOL_HOURS: "overridable",
  NO_OCCURRENCES: "overridable",
};

/** What the other side of a clash is: a weekly slot or a single lesson. */
export type ConflictCounterpart = { kind: "slot" | "lesson"; id: string };

/** IDs the editor can link to or highlight. */
export type ConflictRefs = {
  teacherId?: string;
  roomId?: string;
  groupId?: string;
  studentIds?: string[];
  holidayId?: string;
  availabilityId?: string;
  termId?: string;
  /** The clashing slot or lesson, for double bookings. */
  counterpart?: ConflictCounterpart;
};

/**
 * ICU message arguments. Names are display names; `firstDate` and other
 * dates are "YYYY-MM-DD" and times "HH:MM" in the school's time zone, so the
 * UI may reformat them before passing them to `t()`.
 */
export type ConflictParams = Record<string, string | number>;

export type Conflict = {
  type: ConflictType;
  severity: Severity;
  /**
   * Stable fingerprint of this conflict (type + what it clashes with). The
   * editor sends back the keys the admin acknowledged; the server saves only
   * if every overridable conflict it recomputes is among them.
   */
  key: string;
  /** Affected dates, ascending; empty when the conflict is not date-specific. */
  dates: IsoDate[];
  params: ConflictParams;
  refs: ConflictRefs;
};

/** i18n key of a conflict's message, relative to the `scheduling` namespace. */
export function conflictMessageKey(conflict: Pick<Conflict, "type">): string {
  return `conflicts.${conflict.type}`;
}

export type SaveDecision =
  | { ok: true; overridden: Conflict[] }
  | {
      ok: false;
      reason: "BLOCKING_CONFLICTS" | "UNACKNOWLEDGED_CONFLICTS";
      blocking: Conflict[];
      unacknowledged: Conflict[];
    };

/**
 * Whether a change with `conflicts` may be saved: never with a blocking
 * conflict; with overridable ones only if the admin acknowledged each of
 * them (by key). `overridden` is what the audit log records.
 */
export function decideSave(
  conflicts: readonly Conflict[],
  acknowledgedKeys: readonly string[],
): SaveDecision {
  const acknowledged = new Set(acknowledgedKeys);
  const blocking = conflicts.filter((c) => c.severity === "blocking");
  const overridable = conflicts.filter((c) => c.severity === "overridable");
  const unacknowledged = overridable.filter((c) => !acknowledged.has(c.key));
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: "BLOCKING_CONFLICTS",
      blocking,
      unacknowledged,
    };
  }
  if (unacknowledged.length > 0) {
    return {
      ok: false,
      reason: "UNACKNOWLEDGED_CONFLICTS",
      blocking,
      unacknowledged,
    };
  }
  return { ok: true, overridden: overridable };
}
