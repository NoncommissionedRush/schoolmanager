// Property-style tests of the absence, replacement and reschedule rules
// (docs/architecture/replacements.md §10) on generated realistic schools:
// 20 teachers, 60 groups, 15 rooms, ~330 students, a clash-free timetable.
// A random sequence of absences, bookings, cancellations, rejections, room
// moves and 1-on-1 reschedules is applied through the rules only, and after
// every step the invariants must hold. Seeds are fixed, so failures are
// reproducible.

import { describe, expect, it } from "vitest";

import { buildCalendar, checkLesson, holidaysOfTerm } from "./conflicts";
import { generateLessonOccurrences } from "./generate-lessons";
import {
  type AbsenceSettings,
  type AttendedLesson,
  checkAbsence,
  checkReplacement,
  type CreditStatus,
  creditState,
  planAbsence,
  planBookingCancel,
  releaseCredit,
  type ReplacementCheckInput,
  reviewReplacement,
  seatsTaken,
} from "./replacements";
import { checkReschedule, isFreeTime, rescheduleOptions } from "./reschedule";
import {
  placeGreedily,
  prng,
  PROPERTY_TEST_TIMEOUT_MS,
  type Random,
  type RealisticSchool,
  realisticSchool,
} from "./testing/realistic";
import { isoWeekday, toZonedDateTime } from "./time";
import type {
  GroupInfo,
  LessonInfo,
  SchedulingContext,
  SlotInfo,
} from "./types";

const SEEDS = [11, 12, 13];
const STEPS = 300;
const SETTINGS: AbsenceSettings = {
  absenceCutoffMinutes: 24 * 60,
  makeupCreditValidDays: 30,
};
const MINUTE = 60_000;

type Credit = {
  id: string;
  studentId: string;
  status: CreditStatus;
  expiresAt: Date;
  sourceLessonId: string;
  fromOneOnOne: boolean;
  /** The ad-hoc lesson a 1-on-1 credit is spent on. */
  rescheduledLessonId: string | null;
};

type Booking = {
  id: string;
  studentId: string;
  creditId: string;
  targetLessonId: string;
  active: boolean;
};

/** The school's state, changed only through what the rules allow. */
class World {
  readonly lessons = new Map<string, LessonInfo>();
  readonly absences = new Map<string, Set<string>>();
  readonly credits = new Map<string, Credit>();
  readonly bookings = new Map<string, Booking>();
  // Indexes over `bookings`, so the per-step invariants stay cheap.
  readonly bookingsInto = new Map<string, Booking[]>();
  readonly bookingsOfStudent = new Map<string, Booking[]>();
  readonly bookingsOfCredit = new Map<string, Booking[]>();
  readonly groups: ReadonlyMap<string, GroupInfo>;
  readonly levelOfGroup = new Map<string, string>();
  readonly levelOfStudent = new Map<string, string | null>();
  readonly groupsOfStudent = new Map<string, string[]>();
  readonly lessonsOfGroup = new Map<string, LessonInfo[]>();
  now: Date;
  private nextId = 0;

  constructor(
    readonly school: RealisticSchool,
    readonly slots: SlotInfo[],
    readonly r: Random,
  ) {
    this.now = new Date("2026-10-12T06:00:00Z"); // Mon 08:00 local
    this.groups = new Map(school.groups.map((g) => [g.id, g]));
    school.groups.forEach((g, i) => this.levelOfGroup.set(g.id, `L${i % 4}`));
    for (const g of school.groups) {
      for (const s of g.studentIds) {
        const list = this.groupsOfStudent.get(s) ?? [];
        list.push(g.id);
        this.groupsOfStudent.set(s, list);
      }
    }
    for (const [student, groupIds] of this.groupsOfStudent) {
      const first = groupIds.find(
        (id) => this.groups.get(id)!.type === "GROUP",
      );
      // A few students without a level (NO_LEVEL).
      this.levelOfStudent.set(
        student,
        first && r.next() < 0.95 ? this.levelOfGroup.get(first)! : null,
      );
    }
    for (const o of generateLessonOccurrences({
      slots,
      term: school.term,
      holidays: holidaysOfTerm(school.holidays, school.term.id),
      timeZone: school.school.timeZone,
    })) {
      this.addLesson({
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
      });
    }
  }

  id(prefix: string) {
    return `${prefix}${this.nextId++}`;
  }

  addLesson(lesson: LessonInfo) {
    this.lessons.set(lesson.id, lesson);
    const list = this.lessonsOfGroup.get(lesson.groupId) ?? [];
    list.push(lesson);
    this.lessonsOfGroup.set(lesson.groupId, list);
  }

  addBooking(booking: Booking) {
    this.bookings.set(booking.id, booking);
    for (const [index, key] of [
      [this.bookingsInto, booking.targetLessonId],
      [this.bookingsOfStudent, booking.studentId],
      [this.bookingsOfCredit, booking.creditId],
    ] as const) {
      const list = index.get(key) ?? [];
      list.push(booking);
      index.set(key, list);
    }
  }

  activeBookings(index: Map<string, Booking[]>, key: string) {
    return (index.get(key) ?? []).filter((b) => b.active);
  }

  isAbsent(lessonId: string, studentId: string) {
    return this.absences.get(lessonId)?.has(studentId) ?? false;
  }

  activeBookingsInto(lessonId: string) {
    return this.activeBookings(this.bookingsInto, lessonId);
  }

  seats(lesson: LessonInfo) {
    return seatsTaken({
      memberIds: this.groups.get(lesson.groupId)!.studentIds,
      absentIds: [...(this.absences.get(lesson.id) ?? [])],
      replacementIds: this.activeBookingsInto(lesson.id).map(
        (b) => b.studentId,
      ),
    });
  }

  capacity(lesson: LessonInfo) {
    if (!lesson.roomId) return null;
    return this.school.rooms.find((r) => r.id === lesson.roomId)!.capacity;
  }

  /** §6 "Lessons the student attends". */
  attending(studentId: string): AttendedLesson[] {
    const own = (this.groupsOfStudent.get(studentId) ?? []).flatMap((g) =>
      (this.lessonsOfGroup.get(g) ?? []).filter(
        (l) => l.status !== "CANCELLED" && !this.isAbsent(l.id, studentId),
      ),
    );
    const booked = this.activeBookings(this.bookingsOfStudent, studentId).map(
      (b) => ({
        ...this.lessons.get(b.targetLessonId)!,
        bookingId: b.id,
      }),
    );
    return [
      ...own.map(({ id, startsAt, endsAt }) => ({ id, startsAt, endsAt })),
      ...booked.map(({ id, startsAt, endsAt, bookingId }) => ({
        id,
        startsAt,
        endsAt,
        bookingId,
      })),
    ];
  }

  context(): SchedulingContext {
    return {
      ...this.school,
      slots: this.slots,
      lessons: [...this.lessons.values()],
      absences: [...this.absences].flatMap(([lessonId, ids]) =>
        [...ids].map((studentId) => ({ lessonId, studentId })),
      ),
      replacements: [...this.bookings.values()]
        .filter((b) => b.active)
        .map((b) => ({ lessonId: b.targetLessonId, studentId: b.studentId })),
    };
  }

  replacementInput(
    studentId: string,
    target: LessonInfo,
    credit: Credit,
  ): ReplacementCheckInput {
    const group = this.groups.get(target.groupId)!;
    return {
      target: {
        id: target.id,
        startsAt: target.startsAt,
        endsAt: target.endsAt,
        status: target.status,
        published: true,
        groupType: group.type,
        groupArchived: false,
        levelId: this.levelOfGroup.get(group.id)!,
        capacity: this.capacity(target),
        seatsTaken: this.seats(target),
      },
      student: {
        id: studentId,
        levelId: this.levelOfStudent.get(studentId) ?? null,
        isMemberOfTarget: group.studentIds.includes(studentId),
      },
      bookings: this.activeBookings(this.bookingsOfStudent, studentId).map(
        (b) => ({ id: b.id, targetLessonId: b.targetLessonId }),
      ),
      credit: {
        id: credit.id,
        studentId: credit.studentId,
        status: credit.status,
        expiresAt: credit.expiresAt,
        sourceLessonId: credit.sourceLessonId,
        fromOneOnOne: credit.fromOneOnOne,
        bookingId:
          this.activeBookings(this.bookingsOfCredit, credit.id)[0]?.id ?? null,
      },
      attending: this.attending(studentId),
    };
  }

  upcoming(lessons: Iterable<LessonInfo>, days = 21) {
    const until = this.now.getTime() + days * 24 * 60 * MINUTE;
    return [...lessons].filter(
      (l) =>
        l.status === "SCHEDULED" &&
        l.startsAt > this.now &&
        l.startsAt.getTime() < until,
    );
  }
}

// ---------------------------------------------------------------------------
// Actions: each one asks the rules and applies only what they allow
// ---------------------------------------------------------------------------

function reportAbsence(w: World) {
  // A third of the reports are for 1-on-1s, which are few but reschedule.
  const oneOnOnes = w.school.groups.filter((g) => g.type === "ONE_ON_ONE");
  const student =
    w.r.next() < 0.3
      ? w.r.pick(w.r.pick(oneOnOnes).studentIds)
      : w.r.pick(w.school.students).id;
  const groupIds = w.groupsOfStudent.get(student) ?? [];
  if (groupIds.length === 0) return;
  const options = w.upcoming(
    groupIds.flatMap((g) => w.lessonsOfGroup.get(g) ?? []),
    10,
  );
  if (options.length === 0) return;
  const lesson = w.r.pick(options);
  const group = w.groups.get(lesson.groupId)!;
  const reasons = checkAbsence(
    {
      lesson: { ...lesson, published: true },
      isMember: true,
      hasActiveReplacement: w
        .activeBookingsInto(lesson.id)
        .some((b) => b.studentId === student),
      alreadyReported: w.isAbsent(lesson.id, student),
    },
    w.now,
  );
  if (reasons.length > 0) return;
  const plan = planAbsence(
    { startsAt: lesson.startsAt, type: group.type },
    SETTINGS,
    w.school.school.timeZone,
    w.now,
  );
  const set = w.absences.get(lesson.id) ?? new Set();
  set.add(student);
  w.absences.set(lesson.id, set);
  if (plan.credit) {
    const id = w.id("c");
    w.credits.set(id, {
      id,
      studentId: student,
      status: "AVAILABLE",
      expiresAt: plan.credit.expiresAt,
      sourceLessonId: lesson.id,
      fromOneOnOne: group.type === "ONE_ON_ONE",
      rescheduledLessonId: null,
    });
  }
  if (plan.cancelLesson) lesson.status = "CANCELLED";
}

function availableCredits(w: World, oneOnOne: boolean) {
  return [...w.credits.values()].filter(
    (c) => c.fromOneOnOne === oneOnOne && creditState(c, w.now) === "AVAILABLE",
  );
}

function book(w: World) {
  const credits = availableCredits(w, false);
  if (credits.length === 0) return;
  const credit = w.r.pick(credits);
  const level = w.levelOfStudent.get(credit.studentId);
  const lessons = w.upcoming(w.lessons.values());
  // Mostly lessons at the student's level, so bookings actually happen.
  const sameLevel = lessons.filter(
    (l) => w.levelOfGroup.get(l.groupId) === level,
  );
  const pool = sameLevel.length > 0 && w.r.next() < 0.9 ? sameLevel : lessons;
  for (const target of w.r.shuffle(pool).slice(0, 25)) {
    const input = w.replacementInput(credit.studentId, target, credit);
    const reasons = checkReplacement(input, w.now);
    // The same answer whatever order the inputs come in.
    expect(
      checkReplacement(
        {
          ...input,
          attending: w.r.shuffle(input.attending),
          bookings: w.r.shuffle(input.bookings),
        },
        w.now,
      ),
    ).toEqual(reasons);
    if (reasons.length > 0) continue;
    const id = w.id("b");
    w.addBooking({
      id,
      studentId: credit.studentId,
      creditId: credit.id,
      targetLessonId: target.id,
      active: true,
    });
    credit.status = "USED";
    return;
  }
}

function release(w: World, booking: Booking, cause: "STUDENT" | "SCHOOL") {
  booking.active = false;
  const credit = w.credits.get(booking.creditId)!;
  const next = releaseCredit(credit, cause, w.school.school.timeZone, w.now);
  credit.status = next.status;
  credit.expiresAt = next.expiresAt;
}

function activeUpcomingBookings(w: World) {
  return [...w.bookings.values()].filter(
    (b) => b.active && w.lessons.get(b.targetLessonId)!.startsAt > w.now,
  );
}

function cancelBooking(w: World) {
  const bookings = activeUpcomingBookings(w);
  if (bookings.length === 0) return;
  const booking = w.r.pick(bookings);
  const plan = planBookingCancel(
    w.lessons.get(booking.targetLessonId)!.startsAt,
    SETTINGS.absenceCutoffMinutes,
    w.now,
  );
  if (!plan.ok) return;
  if (plan.releaseCredit) release(w, booking, "STUDENT");
  else booking.active = false; // late: the credit stays spent
}

function reject(w: World) {
  const bookings = activeUpcomingBookings(w);
  if (bookings.length > 0) release(w, w.r.pick(bookings), "SCHOOL");
}

function moveRoom(w: World) {
  // Mostly lessons with replacement students: that's where the room size
  // depends on more than the group.
  const booked = activeUpcomingBookings(w).map((b) =>
    w.lessons.get(b.targetLessonId)!,
  );
  const lessons =
    booked.length > 0 && w.r.next() < 0.7
      ? booked
      : w.upcoming(w.lessons.values());
  if (lessons.length === 0) return;
  const lesson = w.r.pick(lessons);
  const calendar = buildCalendar(w.context());
  // The first room the checker accepts, smallest first.
  const rooms = [...w.school.rooms].sort(
    (a, b) => (a.capacity ?? Infinity) - (b.capacity ?? Infinity),
  );
  for (const room of rooms) {
    if (room.id === lesson.roomId) continue;
    const candidate = { ...lesson, roomId: room.id };
    if (checkLesson(calendar, candidate).length === 0) {
      lesson.roomId = room.id;
      return;
    }
  }
}

function reschedule(w: World) {
  const credits = availableCredits(w, true);
  if (credits.length === 0) return;
  const credit = w.r.pick(credits);
  const source = w.lessons.get(credit.sourceLessonId)!;
  const calendar = buildCalendar(w.context());
  const { timeZone } = w.school.school;
  const request = {
    mode: "student" as const,
    groupId: source.groupId,
    teacherId: source.teacherId,
    movingLessonId: null,
    durationMinutes:
      (source.endsAt.getTime() - source.startsAt.getTime()) / MINUTE,
    credit: {
      studentId: credit.studentId,
      status: credit.status,
      expiresAt: credit.expiresAt,
      sourceGroupId: source.groupId,
      spentOnMoving: false,
    },
    studentId: credit.studentId,
    cutoffMinutes: SETTINGS.absenceCutoffMinutes,
    publishedTermIds: [w.school.term.id],
    attending: w.attending(credit.studentId),
  };
  const local = toZonedDateTime(source.startsAt, timeZone);
  const options = rescheduleOptions(
    calendar,
    request,
    { weekday: isoWeekday(local.date), startMinute: local.minute },
    [source.roomId],
    w.now,
    3,
  );
  for (const option of options) {
    // Every offered time is free: no rule reason and no conflict at all.
    const check = checkReschedule(calendar, request, option, w.now);
    expect(isFreeTime(check)).toBe(true);
    expect(
      checkLesson(calendar, {
        termId: check.termId!,
        timetableSlotId: null,
        occurrenceDate: null,
        groupId: source.groupId,
        teacherId: source.teacherId,
        substituteTeacherId: null,
        ...option,
      }),
    ).toEqual([]);
  }
  if (options.length === 0) return;
  const id = w.id("adhoc");
  w.addLesson({
    id,
    termId: w.school.term.id,
    timetableSlotId: null,
    occurrenceDate: null,
    groupId: source.groupId,
    teacherId: source.teacherId,
    substituteTeacherId: null,
    roomId: options[0].roomId,
    startsAt: options[0].startsAt,
    endsAt: options[0].endsAt,
    status: "SCHEDULED",
  });
  credit.status = "USED";
  credit.rescheduledLessonId = id;
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

// The lesson and pair loops below run tens of thousands of times per seed:
// they collect violations and assert once, since a per-item `expect` is what
// made this test slow enough to time out on CI.
function checkInvariants(w: World) {
  // Room size: no lesson ever holds more students than its room (§5). The
  // timetable starts within capacity; only rule-approved changes follow.
  const overfull: string[] = [];
  for (const lesson of w.lessons.values()) {
    if (lesson.status === "CANCELLED") continue;
    const capacity = w.capacity(lesson);
    const seats = w.seats(lesson);
    if (capacity !== null && seats > capacity) {
      overfull.push(`${lesson.id}: ${seats} seats > capacity ${capacity}`);
    }
  }
  expect(overfull).toEqual([]);
  // A credit backs at most one thing, and is USED exactly while it does.
  for (const credit of w.credits.values()) {
    const active = w.activeBookings(w.bookingsOfCredit, credit.id);
    expect(active.length, credit.id).toBeLessThanOrEqual(1);
    if (active.length > 0 || credit.rescheduledLessonId) {
      expect(credit.status).toBe("USED");
    }
    expect(active.length > 0 && credit.rescheduledLessonId !== null).toBe(
      false,
    );
  }
  // No student is ever in two overlapping lessons.
  const overlaps: string[] = [];
  for (const { id: studentId } of w.school.students) {
    const lessons = [...w.attending(studentId)].sort(
      (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
    );
    for (let i = 1; i < lessons.length; i++) {
      if (lessons[i - 1].endsAt.getTime() > lessons[i].startsAt.getTime()) {
        overlaps.push(
          `${studentId}: ${lessons[i - 1].id} overlaps ${lessons[i].id}`,
        );
      }
    }
  }
  expect(overlaps).toEqual([]);
  // A booking the rules accepted stays clean under admin review: nothing
  // the rules allow later (absences, cancellations, room moves within
  // capacity, reschedules) makes it fail.
  for (const booking of activeUpcomingBookings(w)) {
    const credit = w.credits.get(booking.creditId)!;
    const target = w.lessons.get(booking.targetLessonId)!;
    expect(
      reviewReplacement(
        w.replacementInput(booking.studentId, target, credit),
        booking.id,
        w.now,
      ),
      booking.id,
    ).toEqual([]);
  }
}

describe.each(SEEDS)(
  "replacement rules on a realistic school, seed %i",
  { timeout: PROPERTY_TEST_TIMEOUT_MS },
  (seed) => {
    it("keeps every invariant through a random sequence of actions", () => {
      const school = realisticSchool(seed);
      const { placed } = placeGreedily(school, seed);
      const w = new World(school, placed, prng(seed * 31));
      const actions: [number, (w: World) => void][] = [
        [30, reportAbsence],
        [35, book],
        [10, cancelBooking],
        [5, reject],
        [15, moveRoom],
        [5, reschedule],
      ];
      const total = actions.reduce((sum, [weight]) => sum + weight, 0);
      for (let step = 0; step < STEPS; step++) {
        let roll = w.r.next() * total;
        const [, action] =
          actions.find(([weight]) => (roll -= weight) < 0) ?? actions[0];
        action(w);
        w.now = new Date(w.now.getTime() + w.r.int(0, 180) * MINUTE);
        if (step % 10 === 9) checkInvariants(w);
      }
      checkInvariants(w);
      // The run exercised the rules, not just refusals.
      expect([...w.bookings.values()].length).toBeGreaterThan(10);
      expect(
        [...w.credits.values()].filter((c) => c.rescheduledLessonId).length,
      ).toBeGreaterThan(0);
    });

    it("checks lessons the same way whatever order the context comes in", () => {
      const school = realisticSchool(seed);
      const { placed } = placeGreedily(school, seed);
      const w = new World(school, placed, prng(seed * 37));
      for (let step = 0; step < 120; step++) {
        [reportAbsence, book, book][step % 3](w);
        w.now = new Date(w.now.getTime() + 60 * MINUTE);
      }
      const context = w.context();
      const shuffled: SchedulingContext = {
        ...context,
        lessons: w.r.shuffle(context.lessons),
        absences: w.r.shuffle(context.absences ?? []),
        replacements: w.r.shuffle(context.replacements ?? []),
        groups: w.r.shuffle(context.groups),
      };
      const a = buildCalendar(context);
      const b = buildCalendar(shuffled);
      for (const lesson of w.r
        .shuffle(w.upcoming(w.lessons.values()))
        .slice(0, 40)) {
        for (const room of w.r.shuffle(school.rooms).slice(0, 3)) {
          const candidate = { ...lesson, roomId: room.id };
          expect(checkLesson(b, candidate)).toEqual(checkLesson(a, candidate));
        }
      }
    });
  },
);
