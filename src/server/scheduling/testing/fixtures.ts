// Small hand-written scheduling contexts for unit tests.

import type {
  GroupInfo,
  LessonInfo,
  RoomInfo,
  SchedulingContext,
  SlotInfo,
} from "../types";

export const TZ = "Europe/Bratislava";

/** Monday 2026-10-12 … Sunday 2026-11-08 (DST ends 2026-10-25). */
export const TERM = {
  id: "term",
  name: "Autumn",
  startDate: "2026-10-12",
  endDate: "2026-11-08",
};

export const h = (hours: number, minutes = 0) => hours * 60 + minutes;

export function group(
  id: string,
  studentIds: string[],
  extra: Partial<GroupInfo> = {},
): GroupInfo {
  return {
    id,
    name: `Group ${id}`,
    type: "GROUP",
    capacity: 10,
    studentIds,
    archived: false,
    ...extra,
  };
}

export function room(id: string, extra: Partial<RoomInfo> = {}): RoomInfo {
  return {
    id,
    name: `Room ${id}`,
    kind: "PHYSICAL",
    capacity: 12,
    archived: false,
    ...extra,
  };
}

export function slot(id: string, extra: Partial<SlotInfo> = {}): SlotInfo {
  return {
    id,
    termId: TERM.id,
    groupId: "g1",
    teacherId: "t1",
    roomId: "r1",
    weekday: 1,
    startMinute: h(9),
    endMinute: h(10, 30),
    validFrom: null,
    validUntil: null,
    ...extra,
  };
}

export function lesson(id: string, extra: Partial<LessonInfo>): LessonInfo {
  return {
    id,
    termId: TERM.id,
    timetableSlotId: null,
    occurrenceDate: null,
    groupId: "g1",
    teacherId: "t1",
    substituteTeacherId: null,
    roomId: "r1",
    startsAt: new Date("2026-10-13T07:00:00Z"),
    endsAt: new Date("2026-10-13T08:30:00Z"),
    status: "SCHEDULED",
    ...extra,
  };
}

/** Three teachers, three groups (g3 shares student s2 with g1), two rooms + online. */
export function context(
  extra: Partial<SchedulingContext> = {},
): SchedulingContext {
  return {
    school: {
      timeZone: TZ,
      teachingWeekdays: [1, 2, 3, 4, 5, 6],
      dayStartMinute: h(7),
      dayEndMinute: h(21),
    },
    terms: [TERM],
    holidays: [],
    slots: [],
    lessons: [],
    groups: [
      group("g1", ["s1", "s2"]),
      group("g2", ["s3"]),
      group("g3", ["s2", "s4"]),
    ],
    rooms: [
      room("r1"),
      room("r2", { capacity: 1 }),
      room("online", { kind: "ONLINE", capacity: null }),
    ],
    teachers: [
      { id: "t1", name: "Anna" },
      { id: "t2", name: "Ben" },
      { id: "t3", name: "Cleo" },
    ],
    students: ["s1", "s2", "s3", "s4"].map((id) => ({
      id,
      name: `Student ${id}`,
    })),
    availability: [],
    ...extra,
  };
}
