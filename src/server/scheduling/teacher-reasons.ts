// Teacher-typed conflicts as reasons a teacher can't (or shouldn't) take a
// time, shared by the generator's picker (generator.md §3.1 rule 3) and the
// substitute picker (phase5-rules.md §3.3), so both explain the same clash
// with the same code and params.

import type { Conflict, ConflictParams, ConflictRefs } from "./conflict-types";

export type TeacherConflictReasonCode =
  "BUSY" | "UNAVAILABLE_WEEKLY" | "UNAVAILABLE_ON_DATE";

/** Same shape as a conflict's message: code, ICU params, refs to link. */
export type TeacherConflictReason = {
  code: TeacherConflictReasonCode;
  params: ConflictParams;
  refs: ConflictRefs;
};

/**
 * Reasons from the teacher-typed conflicts of one time on `weekday`:
 * weekly unavailability first, then one-off unavailability (only with
 * `onDate`; the generator leaves it to warnings), then double bookings.
 */
export function teacherConflictReasons(
  weekday: number,
  conflicts: readonly Conflict[],
  { onDate = false }: { onDate?: boolean } = {},
): TeacherConflictReason[] {
  const out: TeacherConflictReason[] = [];
  for (const c of conflicts) {
    if (c.type === "TEACHER_UNAVAILABLE_WEEKLY") {
      out.push({
        code: "UNAVAILABLE_WEEKLY",
        params: {
          weekday,
          time: c.params.time ?? "",
          allDay: c.params.allDay ?? "no",
        },
        refs: c.refs,
      });
    }
  }
  if (onDate) {
    for (const c of conflicts) {
      if (c.type === "TEACHER_UNAVAILABLE_ON_DATE") {
        out.push({
          code: "UNAVAILABLE_ON_DATE",
          params: {
            date: c.params.firstDate ?? c.dates[0] ?? "",
            time: c.params.time ?? "",
            allDay: c.params.allDay ?? "no",
          },
          refs: c.refs,
        });
      }
    }
  }
  for (const c of conflicts) {
    if (c.type === "TEACHER_DOUBLE_BOOKED") {
      out.push({
        code: "BUSY",
        params: {
          weekday,
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
