import { describe, expect, it } from "vitest";

import scheduling from "../../../messages/en-GB/scheduling.json";
import type { SchedulingErrorCode } from "../timetable/service";
import { CONFLICT_TYPES } from "./conflict-types";
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
