import { z } from "zod";

import { formatMinutes } from "@/server/scheduling/time";

import { encodeMessage, issue } from "../validation";

/**
 * A group's regular weekly lesson times (docs/design/timetable-generator.md
 * §5.1, docs/architecture/generator.md §2.1). Pure rules shared by the
 * form (client-side validation) and the service (source of truth).
 */

export const MAX_LESSON_TIMES = 7;
/** The form offers 15-minute steps; the table accepts the 5-minute grid. */
export const LESSON_TIME_STEP = 5;

const minute = z
  .number({ error: encodeMessage("validation.time") })
  .int({ error: encodeMessage("validation.time") })
  .min(0, { error: encodeMessage("validation.time") })
  .max(24 * 60, { error: encodeMessage("validation.time") })
  .refine((value) => value % LESSON_TIME_STEP === 0, {
    error: encodeMessage("validation.time"),
  });

export const lessonTimeSchema = z.object({
  weekday: z
    .number({ error: encodeMessage("validation.requiredField") })
    .int()
    .min(1, { error: encodeMessage("validation.requiredField") })
    .max(7, { error: encodeMessage("validation.requiredField") }),
  startMinute: minute,
  endMinute: minute,
  roomId: z.uuid({
    error: encodeMessage("validation.select", {
      field: { key: "groups.lessonTimes.room" },
    }),
  }),
});

export type LessonTimeInput = z.output<typeof lessonTimeSchema>;

/** Two rows of one group overlap (same weekday, intersecting minutes). */
export function overlaps(
  a: Pick<LessonTimeInput, "weekday" | "startMinute" | "endMinute">,
  b: Pick<LessonTimeInput, "weekday" | "startMinute" | "endMinute">,
): boolean {
  return (
    a.weekday === b.weekday &&
    a.startMinute < b.endMinute &&
    b.startMinute < a.endMinute
  );
}

/** Index of the first row that overlaps an earlier row, or -1. */
export function firstOverlap(
  times: readonly Pick<
    LessonTimeInput,
    "weekday" | "startMinute" | "endMinute"
  >[],
): number {
  for (let i = 1; i < times.length; i++) {
    for (let j = 0; j < i; j++) {
      if (overlaps(times[i], times[j])) return i;
    }
  }
  return -1;
}

/**
 * Save lesson times: 0–7 rows (a group with none is skipped by the
 * generator), each with end after start, no two overlapping. Errors land on
 * `times.<row>.<field>` so the form can show them on the row.
 */
export const lessonTimesSchema = z
  .object({
    times: z.array(lessonTimeSchema).max(MAX_LESSON_TIMES, {
      error: encodeMessage("validation.lessonTimesMax", {
        max: MAX_LESSON_TIMES,
      }),
    }),
  })
  .superRefine(({ times }, ctx) => {
    times.forEach((time, index) => {
      if (time.endMinute <= time.startMinute) {
        issue(ctx, `times.${index}.endMinute`, "validation.timeOrder");
      }
    });
    const overlap = firstOverlap(times);
    if (overlap >= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["times", overlap, "startMinute"],
        message: encodeMessage("validation.lessonTimesOverlap"),
      });
    }
  });

export type LessonTimesInput = z.output<typeof lessonTimesSchema>;

export type RoomInfo = {
  id: string;
  name: string;
  online: boolean;
  capacity: number | null;
  archived: boolean;
};

/** Another group's lesson time, as stored. */
export type OtherLessonTime = LessonTimeInput & {
  groupId: string;
  groupName: string;
};

export type RoomClash = {
  index: number;
  roomId: string;
  otherGroupName: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
};

/**
 * A physical room used by another group at an overlapping time: blocking
 * (§5.1 live check). Online rooms can be shared, as in the editor, where a
 * shared online room is only a warning.
 */
export function roomClashes(
  times: readonly LessonTimeInput[],
  others: readonly OtherLessonTime[],
  rooms: ReadonlyMap<string, RoomInfo>,
): RoomClash[] {
  const out: RoomClash[] = [];
  times.forEach((time, index) => {
    if (rooms.get(time.roomId)?.online) return;
    const other = others.find(
      (o) => o.roomId === time.roomId && overlaps(o, time),
    );
    if (other) {
      out.push({
        index,
        roomId: time.roomId,
        otherGroupName: other.groupName,
        weekday: other.weekday,
        startMinute: other.startMinute,
        endMinute: other.endMinute,
      });
    }
  });
  return out;
}

export type LessonTimeWarning =
  | { code: "ROOM_CAPACITY"; index: number; capacity: number; members: number }
  | { code: "OUTSIDE_SCHOOL_DAYS"; index: number }
  | { code: "OUTSIDE_SCHOOL_HOURS"; index: number }
  | { code: "ROOM_ARCHIVED"; index: number };

/**
 * Non-blocking hints for the form: room too small, archived room, outside
 * school days or hours. The generator's readiness repeats the authoritative
 * checks; these only help while typing.
 */
export function lessonTimeWarnings(
  times: readonly Partial<LessonTimeInput>[],
  rooms: ReadonlyMap<string, RoomInfo>,
  members: number,
  school: {
    teachingWeekdays: readonly number[];
    dayStartMinute: number;
    dayEndMinute: number;
  },
): LessonTimeWarning[] {
  const out: LessonTimeWarning[] = [];
  times.forEach((time, index) => {
    const room = time.roomId ? rooms.get(time.roomId) : undefined;
    if (room?.archived) out.push({ code: "ROOM_ARCHIVED", index });
    if (
      room &&
      !room.online &&
      room.capacity !== null &&
      room.capacity < members
    ) {
      out.push({
        code: "ROOM_CAPACITY",
        index,
        capacity: room.capacity,
        members,
      });
    }
    if (time.weekday && !school.teachingWeekdays.includes(time.weekday)) {
      out.push({ code: "OUTSIDE_SCHOOL_DAYS", index });
    }
    if (
      time.startMinute !== undefined &&
      time.endMinute !== undefined &&
      (time.startMinute < school.dayStartMinute ||
        time.endMinute > school.dayEndMinute)
    ) {
      out.push({ code: "OUTSIDE_SCHOOL_HOURS", index });
    }
  });
  return out;
}

/** Weekly minutes of a group's lesson times. */
export function weeklyMinutes(
  times: readonly Pick<LessonTimeInput, "startMinute" | "endMinute">[],
): number {
  return times.reduce(
    (sum, t) => sum + Math.max(0, t.endMinute - t.startMinute),
    0,
  );
}

/**
 * Compact label parts: rows with the same time are merged across days,
 * "Tue, Thu 17:00–18:30" (§5.1 group list column). Sorted by first day.
 */
export function compactLessonTimes(
  times: readonly Pick<
    LessonTimeInput,
    "weekday" | "startMinute" | "endMinute"
  >[],
): { weekdays: number[]; startMinute: number; endMinute: number }[] {
  const byTime = new Map<
    string,
    { weekdays: number[]; startMinute: number; endMinute: number }
  >();
  for (const t of [...times].sort(
    (a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute,
  )) {
    const key = `${t.startMinute}-${t.endMinute}`;
    const entry = byTime.get(key) ?? {
      weekdays: [],
      startMinute: t.startMinute,
      endMinute: t.endMinute,
    };
    entry.weekdays.push(t.weekday);
    byTime.set(key, entry);
  }
  return [...byTime.values()];
}

/**
 * "Tue, Thu 17:00–18:30 · Sat 10:00–12:00", given the short weekday names
 * of the viewer's locale. Empty string when the group has no times.
 */
export function lessonTimesLabel(
  times: readonly Pick<
    LessonTimeInput,
    "weekday" | "startMinute" | "endMinute"
  >[],
  weekdayShort: (weekday: number) => string,
): string {
  return compactLessonTimes(times)
    .map(
      (entry) =>
        `${entry.weekdays.map(weekdayShort).join(", ")} ${formatMinutes(entry.startMinute)}–${formatMinutes(entry.endMinute)}`,
    )
    .join(" · ");
}
