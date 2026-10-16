// Property-style tests of the substitute rules (docs/architecture/
// phase5-rules.md §3, §7) on generated realistic schools: 20 teachers, 60
// groups, 15 rooms, a clash-free timetable with its lessons. Seeds are
// fixed, so failures are reproducible.

import { describe, expect, it } from "vitest";

import { buildCalendar, checkLesson, holidaysOfTerm } from "./conflicts";
import { generateLessonOccurrences } from "./generate-lessons";
import {
  checkSubstitute,
  checkSubstituteRemoval,
  isoWeekOf,
  lessonMinutes,
  type SubstituteTeacher,
  suggestSubstitutes,
  teachingMinutes,
} from "./substitutes";
import {
  placeGreedily,
  prng,
  PROPERTY_TEST_TIMEOUT_MS,
  type Random,
  realisticSchool,
} from "./testing/realistic";
import { addDays, isoWeekday, toZonedDateTime, zonedTimeToUtc } from "./time";
import type { LessonInfo, SchedulingContext } from "./types";

const SEEDS = [31, 32, 33];
const NOW = new Date("2026-10-12T06:00:00Z"); // Mon 08:00 local

function world(seed: number) {
  const school = realisticSchool(seed);
  const { placed } = placeGreedily(school, seed);
  const r = prng(seed * 7);
  const lessons: LessonInfo[] = generateLessonOccurrences({
    slots: placed,
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
  }));
  // Everybody teaches every level: rule 7 is unit-tested on its own.
  const levelIds = [
    ...new Set(school.groups.flatMap((g) => (g.levelId ? [g.levelId] : []))),
  ];
  const teachers: SubstituteTeacher[] = school.teachers.map((t) => ({
    id: t.id,
    name: t.name,
    archived: false,
    maxMinutesPerWeek: r.next() < 0.5 ? null : r.int(6, 20) * 60,
  }));
  const context = (current: LessonInfo[]): SchedulingContext => ({
    ...school,
    slots: placed,
    lessons: current,
    teacherLevels: school.teachers.flatMap((t) =>
      levelIds.map((levelId) => ({ teacherId: t.id, levelId })),
    ),
  });
  return { school, placed, lessons, teachers, context, r };
}

const effective = (l: LessonInfo) => l.substituteTeacherId ?? l.teacherId;
const overlaps = (a: LessonInfo, b: LessonInfo) =>
  a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/** Lessons of the next weeks, so the suggestions are about upcoming cover. */
const upcoming = (lessons: LessonInfo[], r: Random, count: number) => {
  const future = lessons.filter(
    (l) =>
      l.startsAt > NOW &&
      l.startsAt.getTime() < NOW.getTime() + 28 * 86_400_000,
  );
  return r.shuffle(future).slice(0, count);
};

describe("substitutes on realistic schools", () => {
  it.each(SEEDS)(
    "seed %i: every suggested substitute leaves no teacher conflict and no one over their max",
    (seed) => {
      const w = world(seed);
      const calendar = buildCalendar(w.context(w.lessons));
      for (const lesson of upcoming(w.lessons, w.r, 25)) {
        const suggestions = suggestSubstitutes(
          calendar,
          lesson,
          w.teachers,
          { groupLessons: [] },
          NOW,
        );
        for (const s of suggestions.filter((x) => x.band === "SUGGESTED")) {
          const applied = { ...lesson, substituteTeacherId: s.teacherId };
          const after = w.lessons.map((l) =>
            l.id === lesson.id ? applied : l,
          );
          const conflicts = checkLesson(
            buildCalendar(w.context(after)),
            applied,
          ).filter(
            (c) =>
              c.type === "TEACHER_DOUBLE_BOOKED" ||
              c.type === "TEACHER_UNAVAILABLE_WEEKLY" ||
              c.type === "TEACHER_UNAVAILABLE_ON_DATE",
          );
          expect(conflicts, `${lesson.id} → ${s.teacherId}`).toEqual([]);
          const max = w.teachers.find(
            (t) => t.id === s.teacherId,
          )!.maxMinutesPerWeek;
          if (max !== null) {
            const week = isoWeekOf(lesson.startsAt, w.school.school.timeZone);
            expect(
              teachingMinutes(after, s.teacherId, week),
            ).toBeLessThanOrEqual(max);
          }
        }
      }
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it.each(SEEDS)(
    "seed %i: BUSY agrees with a brute-force overlap scan",
    (seed) => {
      const w = world(seed);
      const calendar = buildCalendar(w.context(w.lessons));
      for (const lesson of upcoming(w.lessons, w.r, 20)) {
        for (const teacher of w.teachers) {
          if (teacher.id === lesson.teacherId) continue;
          const busy = checkSubstitute(calendar, lesson, teacher).some(
            (r) => r.code === "BUSY",
          );
          const scan = w.lessons.some(
            (other) =>
              other.id !== lesson.id &&
              other.status !== "CANCELLED" &&
              effective(other) === teacher.id &&
              overlaps(other, lesson),
          );
          expect(busy, `${lesson.id} / ${teacher.id}`).toBe(scan);
        }
      }
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it.each(SEEDS)(
    "seed %i: teaching minutes equal the weekly slot minutes in a week without changes",
    (seed) => {
      const w = world(seed);
      const tz = w.school.school.timeZone;
      // A full week inside the term without holidays.
      let monday = addDays(
        w.school.term.startDate,
        (8 - isoWeekday(w.school.term.startDate)) % 7,
      );
      const holidays = holidaysOfTerm(w.school.holidays, w.school.term.id);
      while (
        holidays.some(
          (h) => h.startDate <= addDays(monday, 6) && monday <= h.endDate,
        )
      ) {
        monday = addDays(monday, 7);
      }
      const week = {
        from: zonedTimeToUtc(monday, 0, tz),
        to: zonedTimeToUtc(addDays(monday, 7), 0, tz),
      };
      for (const teacher of w.teachers) {
        const slotMinutes = w.placed
          .filter(
            (s) =>
              s.teacherId === teacher.id &&
              (!s.validFrom || s.validFrom <= addDays(monday, s.weekday - 1)) &&
              (!s.validUntil || addDays(monday, s.weekday - 1) <= s.validUntil),
          )
          .reduce((sum, s) => sum + s.endMinute - s.startMinute, 0);
        expect(teachingMinutes(w.lessons, teacher.id, week), teacher.id).toBe(
          slotMinutes,
        );
      }
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it.each(SEEDS)(
    "seed %i: assign / change / remove / move keep every teacher in one lesson at a time",
    (seed) => {
      const w = world(seed);
      const tz = w.school.school.timeZone;
      const lessons = new Map(w.lessons.map((l) => [l.id, l]));
      const pool = upcoming(w.lessons, w.r, 60).map((l) => l.id);
      const all = () => [...lessons.values()];
      for (let step = 0; step < 120; step++) {
        const lesson = lessons.get(w.r.pick(pool))!;
        const calendar = buildCalendar(w.context(all()));
        const action = w.r.int(0, 3);
        if (action <= 1) {
          // Assign or change: any teacher the rules allow (warnings acknowledged).
          const options = suggestSubstitutes(
            calendar,
            lesson,
            w.teachers,
            { groupLessons: [] },
            NOW,
          ).filter((s) => !s.current && s.band !== "NOT_POSSIBLE");
          if (options.length === 0) continue;
          lessons.set(lesson.id, {
            ...lesson,
            substituteTeacherId: w.r.pick(options).teacherId,
          });
        } else if (action === 2) {
          if (!lesson.substituteTeacherId) continue;
          if (checkSubstituteRemoval(calendar, lesson).refused) continue;
          lessons.set(lesson.id, { ...lesson, substituteTeacherId: null });
        } else {
          // Move (admin, or a reschedule): only if the effective teacher is free.
          const local = toZonedDateTime(lesson.startsAt, tz);
          const minutes = lessonMinutes(lesson);
          const start = zonedTimeToUtc(
            addDays(local.date, w.r.int(-2, 2)),
            w.r.int(8, 18) * 60,
            tz,
          );
          const moved = {
            ...lesson,
            startsAt: start,
            endsAt: new Date(start.getTime() + minutes * 60_000),
          };
          const busy = checkLesson(calendar, moved).some(
            (c) => c.type === "TEACHER_DOUBLE_BOOKED",
          );
          if (busy) continue;
          lessons.set(lesson.id, moved);
        }
        // Invariant: nobody teaches two lessons at once.
        const byTeacher = new Map<string, LessonInfo[]>();
        for (const l of all()) {
          if (l.status === "CANCELLED") continue;
          const list = byTeacher.get(effective(l)) ?? [];
          list.push(l);
          byTeacher.set(effective(l), list);
        }
        for (const [teacher, list] of byTeacher) {
          list.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
          for (let i = 1; i < list.length; i++) {
            expect(
              list[i - 1].endsAt <= list[i].startsAt,
              `step ${step}: ${teacher} in ${list[i - 1].id} and ${list[i].id}`,
            ).toBe(true);
          }
        }
      }
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});
