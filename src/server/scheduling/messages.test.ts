import { describe, expect, it } from "vitest";

import scheduling from "../../../messages/en-GB/scheduling.json";
import type { GeneratorErrorCode } from "../timetable/generator-service";
import type { SchedulingErrorCode } from "../timetable/service";
import { CONFLICT_TYPES } from "./conflict-types";
import type { PickerSection } from "./generator/explain";
import type {
  GroupNoticeCode,
  GroupReasonCode,
  ReadinessStatus,
  Suggestion,
  TeacherReasonCode,
  TeacherWarning,
} from "./generator/types";
import type { CancelReason } from "./lesson-sync";
import type {
  RESCHEDULED,
  SCHOOL_CANCELLED,
  STUDENT_CANCELLED,
} from "./replacements";

// The UI translates conflicts, cancel reasons and service errors by code;
// every code needs a message. (ICU syntax is checked in src/i18n.)

describe("scheduling messages", () => {
  it("has a message for every conflict type and nothing else", () => {
    expect(Object.keys(scheduling.conflicts).sort()).toEqual(
      [...CONFLICT_TYPES].sort(),
    );
  });

  it("has a message for every cancel reason and service error", () => {
    const reasons: Record<
      | CancelReason
      | typeof STUDENT_CANCELLED
      | typeof RESCHEDULED
      | typeof SCHOOL_CANCELLED,
      true
    > = {
      HOLIDAY: true,
      TIMETABLE_CHANGED: true,
      STUDENT_CANCELLED: true,
      RESCHEDULED: true,
      SCHOOL_CANCELLED: true,
    };
    const errors: Record<SchedulingErrorCode, true> = {
      NOT_FOUND: true,
      INVALID_INPUT: true,
      EFFECTIVE_DATE_IN_PAST: true,
      NOT_PUBLISHED: true,
      TERM_HAS_LESSONS: true,
      SLOT_HAS_LESSONS: true,
    };
    expect(Object.keys(scheduling.cancelReasons).sort()).toEqual(
      Object.keys(reasons).sort(),
    );
    expect(Object.keys(scheduling.errors).sort()).toEqual(
      Object.keys(errors).sort(),
    );
  });
});

describe("generator messages", () => {
  it("has a message for every generator code", () => {
    const { generator } = scheduling;
    const status: Record<ReadinessStatus, true> = {
      SKIPPED: true,
      KEPT: true,
      NO_LESSON_TIMES: true,
      NO_ROOM: true,
      TIMES_CLASH: true,
      LEVEL_UNCOVERED: true,
      READY: true,
    };
    const reasons: Record<GroupReasonCode, true> = {
      LEVEL_UNCOVERED: true,
      NO_TEACHER_FITS: true,
      REMOVED_BY_ADMIN: true,
      TIME_LIMIT: true,
      INTERNAL_CHECK_FAILED: true,
    };
    const teacherReasons: Record<TeacherReasonCode, true> = {
      ARCHIVED: true,
      UNAVAILABLE_WEEKLY: true,
      BUSY: true,
      TEACHING_IN_DRAFT: true,
      OVER_MAX_HOURS: true,
    };
    const suggestions: Record<Suggestion["kind"], true> = {
      SWAP: true,
      ONLY_UNAVAILABLE: true,
      ONLY_MAX_HOURS: true,
      NOT_TEACHING_LEVEL: true,
    };
    const notices: Record<
      GroupNoticeCode | TeacherWarning["code"] | "PRE_EXISTING_CONFLICT",
      true
    > = {
      MIXED_TEACHERS: true,
      OVER_MAX_HOURS: true,
      PRE_EXISTING_CONFLICT: true,
    };
    const sections: Record<PickerSection, true> = {
      AVAILABLE: true,
      UNAVAILABLE: true,
      NOT_TEACHING_LEVEL: true,
      OVER_MAX_HOURS: true,
      BUSY: true,
    };
    const errors: Record<
      | GeneratorErrorCode
      | "BLOCKING_CONFLICTS"
      | "UNACKNOWLEDGED_CONFLICTS"
      | "LESSON_TIMES_OVERLAP"
      | "INTERNAL_ERROR",
      true
    > = {
      RUN_IN_PROGRESS: true,
      RUN_INTERRUPTED: true,
      DRAFT_CHANGED: true,
      BLOCKING_CONFLICTS: true,
      UNACKNOWLEDGED_CONFLICTS: true,
      EFFECTIVE_DATE_PASSED: true,
      EFFECTIVE_DATE_OUTSIDE_TERM: true,
      TERM_PUBLISHED: true,
      TERM_NOT_PUBLISHED: true,
      TEACHER_ARCHIVED: true,
      NOTHING_TO_ASSIGN: true,
      GROUP_NOT_IN_DRAFT: true,
      LESSON_TIMES_OVERLAP: true,
      INTERNAL_ERROR: true,
    };
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(generator.status)).toEqual(keys(status));
    expect(keys(generator.reasons)).toEqual(keys(reasons));
    expect(keys(generator.teacherReasons)).toEqual(keys(teacherReasons));
    expect(keys(generator.suggestions)).toEqual(keys(suggestions));
    expect(keys(generator.notices)).toEqual(keys(notices));
    expect(keys(generator.pickerSections)).toEqual(keys(sections));
    expect(keys(generator.errors)).toEqual(keys(errors));
  });
});
