// Deterministic generator of realistic school data for property-style tests:
// 20 teachers, 60 groups (incl. 1-on-1s), 15 rooms (incl. online), ~330
// students, availability rules, holidays and one term. Same seed, same data.

import type {
  AvailabilityRule,
  GroupInfo,
  HolidayInfo,
  PersonInfo,
  RoomInfo,
  SchedulingContext,
  SlotInfo,
  TermInfo,
} from "../types";

/** mulberry32: tiny, fast, seedable PRNG. */
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) =>
    min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
  const shuffle = <T>(items: readonly T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(0, i);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  return { next, int, pick, shuffle };
}

export type Random = ReturnType<typeof prng>;

export const REALISTIC_TERM: TermInfo = {
  id: "term-autumn",
  name: "Autumn 2026",
  startDate: "2026-09-14",
  endDate: "2027-01-29",
};

export type RealisticSchool = Omit<SchedulingContext, "slots" | "lessons"> & {
  term: TermInfo;
  /** Which teacher usually teaches each group. */
  groupTeacher: ReadonlyMap<string, string>;
};

const pad = (n: number) => String(n).padStart(2, "0");

export function realisticSchool(seed: number): RealisticSchool {
  const r = prng(seed);
  const teachers: PersonInfo[] = Array.from({ length: 20 }, (_, i) => ({
    id: `t${pad(i)}`,
    name: `Teacher ${pad(i)}`,
  }));
  const rooms: RoomInfo[] = Array.from({ length: 15 }, (_, i) =>
    i < 12
      ? {
          id: `r${pad(i)}`,
          name: `Room ${pad(i)}`,
          kind: "PHYSICAL",
          capacity: r.int(4, 14),
        }
      : {
          id: `r${pad(i)}`,
          name: `Online ${i}`,
          kind: "ONLINE",
          capacity: null,
        },
  );

  const students: PersonInfo[] = [];
  const groups: GroupInfo[] = [];
  const groupTeacher = new Map<string, string>();
  for (let i = 0; i < 60; i++) {
    const oneOnOne = i >= 50;
    const size = oneOnOne ? 1 : r.int(3, 10);
    const ids = Array.from({ length: size }, () => {
      const id = `s${pad(students.length)}`;
      students.push({ id, name: `Student ${id}` });
      return id;
    });
    groups.push({
      id: `g${pad(i)}`,
      name: `Group ${pad(i)}`,
      type: oneOnOne ? "ONE_ON_ONE" : "GROUP",
      capacity: oneOnOne ? 1 : 12,
      studentIds: ids,
      archived: false,
    });
    groupTeacher.set(`g${pad(i)}`, r.pick(teachers).id);
  }
  // Some students also attend a second group (e.g. a 1-on-1 on top).
  for (let i = 0; i < 25; i++) {
    const student = r.pick(students).id;
    const target = r.pick(groups);
    if (target.type === "GROUP" && !target.studentIds.includes(student)) {
      (target.studentIds as string[]).push(student);
    }
  }

  const availability: AvailabilityRule[] = [];
  for (const teacher of teachers) {
    for (let k = r.int(0, 2); k > 0; k--) {
      const start = r.int(14, 34) * 30;
      availability.push({
        id: `av-${teacher.id}-w${k}`,
        teacherId: teacher.id,
        kind: "WEEKLY_UNAVAILABLE",
        weekday: r.int(1, 6),
        date: null,
        startMinute: start,
        endMinute: start + r.int(2, 8) * 30,
      });
    }
    for (let k = r.int(0, 2); k > 0; k--) {
      const allDay = r.next() < 0.5;
      const start = r.int(14, 36) * 30;
      availability.push({
        id: `av-${teacher.id}-d${k}`,
        teacherId: teacher.id,
        kind: r.next() < 0.75 ? "DATE_UNAVAILABLE" : "DATE_AVAILABLE",
        weekday: null,
        date: `2026-${pad(r.int(9, 12))}-${pad(r.int(1, 28))}`,
        startMinute: allDay ? null : start,
        endMinute: allDay ? null : start + 120,
      });
    }
  }

  const holidays: HolidayInfo[] = [
    {
      id: "hol-autumn",
      name: "Autumn break",
      termId: REALISTIC_TERM.id,
      startDate: "2026-10-29",
      endDate: "2026-10-30",
    },
    {
      id: "hol-nov17",
      name: "Public holiday",
      termId: null,
      startDate: "2026-11-17",
      endDate: "2026-11-17",
    },
    {
      id: "hol-xmas",
      name: "Christmas",
      termId: REALISTIC_TERM.id,
      startDate: "2026-12-21",
      endDate: "2027-01-06",
    },
  ];

  return {
    school: {
      timeZone: "Europe/Bratislava",
      teachingWeekdays: [1, 2, 3, 4, 5, 6],
      dayStartMinute: 7 * 60,
      dayEndMinute: 21 * 60,
    },
    term: REALISTIC_TERM,
    terms: [REALISTIC_TERM],
    holidays,
    groups,
    rooms,
    teachers,
    students,
    availability,
    groupTeacher,
  };
}

/** A random weekly slot for `group`, 90 minutes on a half-hour grid. */
export function randomSlot(
  r: Random,
  school: RealisticSchool,
  group: GroupInfo,
  id: string,
): SlotInfo {
  const start = r.int(16, 39) * 30; // 08:00 … 19:30
  return {
    id,
    termId: school.term.id,
    groupId: group.id,
    teacherId:
      r.next() < 0.8
        ? school.groupTeacher.get(group.id)!
        : r.pick(school.teachers).id,
    roomId: r.pick(school.rooms).id,
    weekday: r.int(1, 6),
    startMinute: start,
    endMinute: start + 90,
    validFrom: null,
    validUntil: null,
  };
}

/** Two random slots per group; clashes are expected. */
export function randomTimetable(
  seed: number,
  school: RealisticSchool,
): SlotInfo[] {
  const r = prng(seed);
  return school.groups.flatMap((group) => [
    randomSlot(r, school, group, `${group.id}-a`),
    randomSlot(r, school, group, `${group.id}-b`),
  ]);
}
