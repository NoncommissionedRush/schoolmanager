// Plain-data input and output of the teacher-assignment generator
// (docs/architecture/generator.md). Like the rest of the scheduling module it
// never imports Prisma or Next.js; the service in
// src/server/timetable/generator-service.ts loads and stores these.

import type { Conflict, ConflictParams, ConflictRefs } from "../conflict-types";
import type { IsoDate, SchedulingContext } from "../types";

/** How a draft applies (§5.2). */
export type DraftMode = "REPLACE" | "FILL" | "REPLAN_FROM";

export type AssignmentOrigin = "GENERATED" | "MANUAL" | "IMPORTED";

/** One `GroupLessonTime` row (§2.1). */
export type LessonTimeInfo = {
  id: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  roomId: string;
};

/** A non-archived group with its lesson times and level. */
export type GeneratorGroup = {
  id: string;
  name: string;
  levelId: string;
  lessonTimes: readonly LessonTimeInfo[];
  /** A `GroupTermSkip` row exists for the term. */
  skipped: boolean;
};

export type GeneratorTeacher = {
  id: string;
  name: string;
  /** `TeacherLevel` rows. */
  levelIds: readonly string[];
  /** Null = no limit (§2.3). */
  maxMinutesPerWeek: number | null;
  /** `User.deletedAt` set. */
  archived: boolean;
};

export type GeneratorLevel = { id: string; name: string };

/** A stored `TimetableDraftAssignment`. */
export type DraftAssignmentInput = {
  groupId: string;
  /** Null = no teacher. */
  teacherId: string | null;
  locked: boolean;
  origin: AssignmentOrigin;
};

export type GeneratorInput = {
  /**
   * The checker's context for the term and every overlapping term, with the
   * live slots and lessons (`loadContext`). Its groups, rooms and teachers
   * cover every id used below.
   */
  context: SchedulingContext;
  termId: string;
  mode: DraftMode;
  /** _D_ for FILL and REPLAN_FROM; ignored (term start) for REPLACE. */
  effectiveFrom: IsoDate | null;
  /** Every non-archived group of the school. */
  groups: readonly GeneratorGroup[];
  /** Every teacher of the school, archived ones included. */
  teachers: readonly GeneratorTeacher[];
  levels: readonly GeneratorLevel[];
  /**
   * The draft's assignments. Locked ones are kept as given; in REPLAN_FROM
   * the live teachers are imported by the engine itself, so unlocked rows
   * are ignored by a run (`evaluateDraft` uses all of them).
   */
  assignments: readonly DraftAssignmentInput[];
  /** Moves evaluated in the improvement phase (default 200 000, §4.4). */
  maxIterations?: number;
  /** Wall-time safety cap (default 10 s); needs `options.clock`. */
  timeLimitMs?: number;
};

export type GeneratorOptions = {
  /**
   * Milliseconds, monotonic (e.g. `performance.now`). Only used for the
   * time cap; without it the run is limited by iterations alone, which is
   * what tests use.
   */
  clock?: () => number;
};

// ---------------------------------------------------------------------------
// Readiness (§2.5)
// ---------------------------------------------------------------------------

export type ReadinessStatus =
  | "SKIPPED"
  /** FILL: the group has live slots from _D_; they stay as they are. */
  | "KEPT"
  | "NO_LESSON_TIMES"
  | "NO_ROOM"
  | "TIMES_CLASH"
  | "LEVEL_UNCOVERED"
  | "READY";

/** One weekly lesson a run must staff (§2.4). */
export type DraftTime = {
  /** `lt:<GroupLessonTime.id>` or `slot:<TimetableSlot.id>`. */
  key: string;
  groupId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  roomId: string | null;
  validFrom: IsoDate | null;
  validUntil: IsoDate | null;
  /** The live slot this time comes from (published modes). */
  liveSlotId: string | null;
  lessonTimeId: string | null;
};

/** A conflict of one of a group's times, keyed for acknowledging on apply. */
export type DraftConflict = Conflict & {
  timeKey: string;
  /** `<groupId>|<weekday>|<start>|<end>|<conflict key>` (§5.6 step 3). */
  draftKey: string;
};

export type GroupReadiness = {
  groupId: string;
  levelId: string;
  status: ReadinessStatus;
  times: DraftTime[];
  /** Weekly minutes of `times`. */
  minutes: number;
  /** Teacher of the group's live slots from the start date, when they agree. */
  currentTeacherId: string | null;
  /** The live slots have different teachers (`MIXED_TEACHERS`). */
  mixedTeachers: boolean;
  /** TIMES_CLASH: the blocking conflicts no teacher can fix. */
  clashes: DraftConflict[];
  /** Overridable conflicts of the times themselves (warnings, §2.5). */
  timeWarnings: DraftConflict[];
};

export type ReadinessChecks = {
  noTimes: string[];
  roomClash: { groupId: string; otherGroupId: string; roomId: string }[];
  levelUncovered: string[];
  timeCrunch: {
    weekday: number;
    minute: number;
    /** Null = all levels at that time; otherwise the one-level subset. */
    levelId: string | null;
    groups: number;
    teachers: number;
  }[];
  teachersNoLevels: string[];
  hours: { neededMinutes: number; availableMinutes: number };
  studentClash: string[];
};

export type Readiness = {
  termId: string;
  mode: DraftMode;
  startDate: IsoDate;
  /** Every non-archived group, sorted by id. */
  groups: GroupReadiness[];
  checks: ReadinessChecks;
};

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** The objective (§3.3); smaller wins, compared key by key. */
export type Objective = {
  unassignedGroups: number;
  unassignedMinutes: number;
  keptIneligible: number;
  changedTeachers: number;
  workloadPenalty: number;
  workloadRange: number;
};

export type TeacherWorkload = {
  teacherId: string;
  minutes: number;
  groups: number;
  teachingDays: number;
  maxMinutes: number | null;
};

export type WorkloadSummary = Objective & {
  minMinutes: number;
  maxMinutes: number;
  averageMinutes: number;
  /** The pool and every teacher with a draft group, sorted by id. */
  perTeacher: TeacherWorkload[];
};

export type DraftAssignmentResult = {
  groupId: string;
  teacherId: string | null;
  locked: boolean;
  origin: AssignmentOrigin;
  /** REPLAN_FROM: kept with a current teacher who is no longer eligible. */
  fallback: boolean;
  minutes: number;
};

export type GroupReasonCode =
  | "LEVEL_UNCOVERED"
  | "NO_TEACHER_FITS"
  | "REMOVED_BY_ADMIN"
  | "TIME_LIMIT"
  | "INTERNAL_CHECK_FAILED";

export type TeacherReasonCode =
  | "ARCHIVED"
  | "UNAVAILABLE_WEEKLY"
  | "BUSY"
  | "TEACHING_IN_DRAFT"
  | "OVER_MAX_HOURS";

/** Same shape as a conflict's message: code, ICU params, refs to link. */
export type TeacherReason = {
  code: TeacherReasonCode;
  params: ConflictParams;
  refs: ConflictRefs;
};

export type TeacherReasons = {
  teacherId: string;
  archived: boolean;
  reasons: TeacherReason[];
};

export type Suggestion =
  | {
      kind: "SWAP";
      teacherId: string;
      otherGroupId: string;
      otherTeacherId: string;
      otherLocked: boolean;
      workloadPenalty: number;
    }
  | { kind: "ONLY_UNAVAILABLE"; teacherId: string }
  | { kind: "ONLY_MAX_HOURS"; teacherId: string }
  | { kind: "NOT_TEACHING_LEVEL"; teacherId: string };

export type UnassignedGroup = {
  groupId: string;
  levelId: string;
  reason: GroupReasonCode;
  params: ConflictParams;
  /** Teachers of the level (archived last) and every reason each can't. */
  teachers: TeacherReasons[];
  suggestions: Suggestion[];
};

export type GroupNoticeCode = "MIXED_TEACHERS";

/** Warnings shown on a group's row of the draft. */
export type GroupWarnings = {
  groupId: string;
  /** Overridable conflicts (and, on locked or kept assignments, hard ones). */
  conflicts: DraftConflict[];
  notices: { code: GroupNoticeCode; params: ConflictParams }[];
};

export type TeacherWarning = {
  code: "OVER_MAX_HOURS";
  teacherId: string;
  minutes: number;
  maxMinutes: number;
  /** `maxHours:<teacherId>`, acknowledged on apply. */
  key: string;
};

export type StoppedBy = "converged" | "iterations" | "time";

export type GeneratorResult = {
  termId: string;
  mode: DraftMode;
  startDate: IsoDate;
  readiness: Readiness;
  /** One per included group, sorted by group id. */
  assignments: DraftAssignmentResult[];
  /** Locked assignments of groups that are no longer included (§5.4). */
  removedAssignments: DraftAssignmentInput[];
  unassigned: UnassignedGroup[];
  warnings: GroupWarnings[];
  teacherWarnings: TeacherWarning[];
  construction: WorkloadSummary;
  final: WorkloadSummary;
  iterations: number;
  stoppedBy: StoppedBy;
};

export type GeneratorPhase = "checking" | "assigning" | "balancing";

/** Yielded by `assignTeachersSteps` (§4.6). */
export type GeneratorProgress = {
  phase: GeneratorPhase;
  assigned: number;
  total: number;
  iterations: number;
};
