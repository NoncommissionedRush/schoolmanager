// Property-style tests on generated realistic data (20 teachers, 60 groups,
// 15 rooms): the checker must agree with a brute-force oracle, be symmetric,
// deterministic and order-independent, and a timetable built with it must be
// clash-free. Seeds are fixed, so failures are reproducible.

import { describe, expect, it } from "vitest";

import type { Conflict } from "./conflict-types";
import {
  buildCalendar,
  checkSlot,
  checkTimetable,
  holidaysOfTerm,
} from "./conflicts";
import { generateLessonOccurrences } from "./generate-lessons";
import {
  type ExistingLesson,
  isEmptyPlan,
  type LessonSyncPlan,
  planLessonSync,
} from "./lesson-sync";
import {
  placeGreedily,
  prng,
  PROPERTY_TEST_TIMEOUT_MS,
  randomTimetable,
  type RealisticSchool,
  realisticSchool,
} from "./testing/realistic";
import { addDays } from "./time";
import type { LessonInfo, SchedulingContext, SlotInfo } from "./types";

const SEEDS = [1, 2, 3, 4, 5];

function contextOf(
  school: RealisticSchool,
  slots: SlotInfo[],
  lessons: LessonInfo[] = [],
): SchedulingContext {
  return { ...school, slots, lessons };
}

const DOUBLE_BOOKINGS = [
  "TEACHER_DOUBLE_BOOKED",
  "ROOM_DOUBLE_BOOKED",
  "ONLINE_ROOM_SHARED",
  "GROUP_DOUBLE_BOOKED",
  "STUDENT_DOUBLE_BOOKED",
] as const;

/** "type → other slot id" pairs a conflict list reports. */
function clashes(conflicts: Conflict[]): string[] {
  return conflicts
    .filter((c) => (DOUBLE_BOOKINGS as readonly string[]).includes(c.type))
    .map((c) => `${c.type}>${c.refs.counterpart!.id}`)
    .sort();
}

/** Brute force: expand every slot to lessons and compare every pair. */
function oracle(school: RealisticSchool, slots: SlotInfo[]) {
  const holidays = holidaysOfTerm(school.holidays, school.term.id);
  const occurrences = generateLessonOccurrences({
    slots,
    term: school.term,
    holidays,
    timeZone: school.school.timeZone,
  });
  const groups = new Map(school.groups.map((g) => [g.id, g]));
  const rooms = new Map(school.rooms.map((r) => [r.id, r]));
  const result = new Map<string, Set<string>>(
    slots.map((s) => [s.id, new Set()]),
  );
  for (const a of occurrences) {
    for (const b of occurrences) {
      if (a.timetableSlotId === b.timetableSlotId) continue;
      if (!(a.startsAt < b.endsAt && b.startsAt < a.endsAt)) continue;
      const found = result.get(a.timetableSlotId)!;
      const other = b.timetableSlotId;
      if (a.teacherId === b.teacherId)
        found.add(`TEACHER_DOUBLE_BOOKED>${other}`);
      if (a.roomId && a.roomId === b.roomId) {
        const kind = rooms.get(a.roomId)!.kind;
        found.add(
          `${kind === "ONLINE" ? "ONLINE_ROOM_SHARED" : "ROOM_DOUBLE_BOOKED"}>${other}`,
        );
      }
      if (a.groupId === b.groupId) {
        found.add(`GROUP_DOUBLE_BOOKED>${other}`);
      } else {
        const theirs = new Set(groups.get(b.groupId)!.studentIds);
        if (groups.get(a.groupId)!.studentIds.some((s) => theirs.has(s))) {
          found.add(`STUDENT_DOUBLE_BOOKED>${other}`);
        }
      }
    }
  }
  return new Map([...result].map(([id, set]) => [id, [...set].sort()]));
}

function asStoredLessons(
  school: RealisticSchool,
  slots: SlotInfo[],
): ExistingLesson[] {
  return generateLessonOccurrences({
    slots,
    term: school.term,
    holidays: holidaysOfTerm(school.holidays, school.term.id),
    timeZone: school.school.timeZone,
  }).map((o) => ({
    id: `${o.timetableSlotId}@${o.date}`,
    termId: school.term.id,
    timetableSlotId: o.timetableSlotId,
    occurrenceDate: o.date,
    groupId: o.groupId,
    teacherId: o.teacherId,
    substituteTeacherId: null,
    roomId: o.roomId,
    startsAt: o.startsAt,
    endsAt: o.endsAt,
    status: "SCHEDULED",
    hasDependents: false,
  }));
}

const slow = { timeout: PROPERTY_TEST_TIMEOUT_MS };

describe.each(SEEDS)("realistic school, seed %i", slow, (seed) => {
  const school = realisticSchool(seed);
  const random = randomTimetable(seed * 7919, school);
  let placement: ReturnType<typeof placeGreedily> | undefined;
  const placed = () => (placement ??= placeGreedily(school, seed));

  it("has the advertised size", () => {
    expect(school.teachers).toHaveLength(20);
    expect(school.groups).toHaveLength(60);
    expect(school.rooms).toHaveLength(15);
    expect(random).toHaveLength(120);
  });

  it("finds exactly the double-bookings a brute-force comparison finds", () => {
    const expected = oracle(school, random);
    const calendar = buildCalendar(contextOf(school, random));
    let total = 0;
    for (const slot of random) {
      const found = clashes(checkSlot(calendar, slot));
      expect(found, slot.id).toEqual(expected.get(slot.id));
      total += found.length;
    }
    // A random timetable must actually exercise the checker.
    expect(total).toBeGreaterThan(10);
  });

  it("reports teacher, room and group clashes on both sides", () => {
    const result = checkTimetable(
      buildCalendar(contextOf(school, random)),
      school.term.id,
    );
    for (const [slotId, conflicts] of result) {
      for (const c of conflicts) {
        if (!(DOUBLE_BOOKINGS as readonly string[]).includes(c.type)) continue;
        const back = result.get(c.refs.counterpart!.id) ?? [];
        expect(
          back.some(
            (b) => b.type === c.type && b.refs.counterpart!.id === slotId,
          ),
          `${c.key} on ${slotId}`,
        ).toBe(true);
      }
    }
  });

  it("is deterministic and independent of input order", () => {
    const r = prng(seed);
    const shuffled: SchedulingContext = {
      ...contextOf(school, r.shuffle(random)),
      groups: r.shuffle(school.groups),
      rooms: r.shuffle(school.rooms),
      teachers: r.shuffle(school.teachers),
      students: r.shuffle(school.students),
      availability: r.shuffle(school.availability),
      holidays: r.shuffle(school.holidays),
    };
    const a = checkTimetable(
      buildCalendar(contextOf(school, random)),
      school.term.id,
    );
    const b = checkTimetable(buildCalendar(shuffled), school.term.id);
    expect([...b]).toEqual([...a]);
  });

  it("gives the same answer before and after lessons are generated", () => {
    const lessons = asStoredLessons(school, random);
    const draft = checkTimetable(
      buildCalendar(contextOf(school, random)),
      school.term.id,
    );
    const published = checkTimetable(
      buildCalendar(contextOf(school, random, lessons)),
      school.term.id,
    );
    expect([...published]).toEqual([...draft]);
  });

  it("lets archived rooms keep their slots but take no new ones", () => {
    const archivedIds = new Set(school.rooms.slice(0, 4).map((r) => r.id));
    const archived: SchedulingContext = {
      ...contextOf(school, random),
      rooms: school.rooms.map((r) => ({
        ...r,
        archived: archivedIds.has(r.id),
      })),
    };
    const before = checkTimetable(
      buildCalendar(contextOf(school, random)),
      school.term.id,
    );
    const calendar = buildCalendar(archived);
    // Existing slots: nothing changes, clashes included.
    expect([...checkTimetable(calendar, school.term.id)]).toEqual([...before]);

    const r = prng(seed * 31);
    let moved = 0;
    for (const slot of random) {
      const target = r.pick(school.rooms);
      const blocked = archivedIds.has(target.id) && target.id !== slot.roomId;
      const asEdit = checkSlot(calendar, { ...slot, roomId: target.id });
      const asNew = checkSlot(calendar, {
        ...slot,
        id: undefined,
        roomId: target.id,
      });
      expect(
        asEdit.some((c) => c.type === "ROOM_ARCHIVED"),
        slot.id,
      ).toBe(blocked);
      expect(
        asNew.some((c) => c.type === "ROOM_ARCHIVED"),
        slot.id,
      ).toBe(archivedIds.has(target.id));
      if (blocked) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  });

  it("builds a clash-free timetable when used for placement", () => {
    const { placed: slots, unplaced } = placed();
    expect(slots.length).toBeGreaterThanOrEqual(110);
    for (const { conflicts } of unplaced)
      expect(conflicts.length).toBeGreaterThan(0);

    const result = checkTimetable(
      buildCalendar(contextOf(school, slots)),
      school.term.id,
    );
    const blocking = [...result.values()]
      .flat()
      .filter((c) => c.severity === "blocking");
    expect(blocking).toEqual([]);
    for (const ids of oracle(school, slots).values()) expect(ids).toEqual([]);
  });

  it("keeps lessons in sync through slot ends and holiday changes", () => {
    const slotsPlaced = placed().placed;
    const tz = school.school.timeZone;
    const holidays = holidaysOfTerm(school.holidays, school.term.id);
    const apply = (lessons: ExistingLesson[], plan: LessonSyncPlan) => {
      const removed = new Set(plan.remove);
      const cancelled = new Set(plan.cancel.map((c) => c.id));
      return [
        ...lessons
          .filter((l) => !removed.has(l.id))
          .map((l) =>
            cancelled.has(l.id) ? { ...l, status: "CANCELLED" as const } : l,
          ),
        ...plan.create.map((o) => ({
          id: `${o.timetableSlotId}@${o.date}`,
          termId: school.term.id,
          timetableSlotId: o.timetableSlotId,
          occurrenceDate: o.date,
          groupId: o.groupId,
          teacherId: o.teacherId,
          substituteTeacherId: null,
          roomId: o.roomId,
          startsAt: o.startsAt,
          endsAt: o.endsAt,
          status: "SCHEDULED" as const,
          hasDependents: false,
        })),
      ];
    };
    const sync = (
      slots: SlotInfo[],
      lessons: ExistingLesson[],
      from: string,
      hols = holidays,
    ) =>
      planLessonSync({
        term: school.term,
        slots,
        holidays: hols,
        lessons,
        timeZone: tz,
        from,
      });

    // Publish.
    let lessons = apply([], sync(slotsPlaced, [], school.term.startDate));
    expect(lessons).toHaveLength(asStoredLessons(school, slotsPlaced).length);

    // Mid-term: some lessons gained history, a few slots end, a holiday is added.
    const today = "2026-11-02";
    const r = prng(seed);
    lessons = lessons.map((l) =>
      r.next() < 0.1 ? { ...l, hasDependents: true } : l,
    );
    const before = new Map(lessons.map((l) => [l.id, l]));
    const ended = new Set(
      r
        .shuffle(slotsPlaced)
        .slice(0, 10)
        .map((s) => s.id),
    );
    const slots = slotsPlaced.map((s) =>
      ended.has(s.id) ? { ...s, validUntil: addDays(today, 3) } : s,
    );
    const snow = {
      id: "snow",
      name: "Snow day",
      termId: null,
      startDate: "2026-12-01",
      endDate: "2026-12-01",
    };
    const plan = sync(slots, lessons, today, [...holidays, snow]);
    lessons = apply(lessons, plan);

    // Idempotent.
    expect(isEmptyPlan(sync(slots, lessons, today, [...holidays, snow]))).toBe(
      true,
    );
    // Nothing before `today` changed.
    for (const [id, l] of before) {
      if (l.occurrenceDate! < today) {
        expect(lessons.find((x) => x.id === id)).toEqual(l);
      }
    }
    // Lessons with history were cancelled, never deleted.
    for (const id of plan.remove)
      expect(before.get(id)!.hasDependents).toBe(false);
    // No scheduled lesson on the snow day or after a slot ended.
    for (const l of lessons) {
      if (l.status !== "SCHEDULED") continue;
      expect(l.occurrenceDate).not.toBe("2026-12-01");
      if (ended.has(l.timetableSlotId!) && l.occurrenceDate! >= today) {
        expect(l.occurrenceDate! <= addDays(today, 3)).toBe(true);
      }
    }
  });
});

describe("performance", () => {
  it("checks a whole 120-slot term quickly", () => {
    const school = realisticSchool(42);
    const slots = randomTimetable(42, school);
    const started = performance.now();
    checkTimetable(buildCalendar(contextOf(school, slots)), school.term.id);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
