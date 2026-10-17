// Property-style tests of the report rules (docs/architecture/
// phase6-rules.md §9) on generated realistic schools: 20 teachers, 60
// groups, 15 rooms, a clash-free timetable with its lessons, plus absences,
// replacements, reschedules, substitutes and membership changes. Seeds are
// fixed, so failures are reproducible.

import { describe, expect, it } from "vitest";

import { attendedLessons } from "@/server/ratings/rules";
import {
  generateLessonOccurrences,
  holidaysOfTerm,
  lessonMinutes,
  teachingMinutes,
} from "@/server/scheduling";
import {
  placeGreedily,
  prng,
  PROPERTY_TEST_TIMEOUT_MS,
  realisticSchool,
} from "@/server/scheduling/testing/realistic";

import {
  type AttendanceInput,
  attendanceReport,
  effectiveTeacher,
  isMakeupLesson,
  periodInstants,
  type ReportAbsence,
  type ReportGroup,
  type ReportLesson,
  type ReportMembership,
  type ReportReplacement,
  teacherHoursReport,
} from "./rules";

const SEEDS = [61, 62, 63];
const DAY = 86_400_000;
// Mid-term: some lessons have ended, some haven't.
const NOW = new Date("2026-12-02T11:00:00Z");

function world(seed: number) {
  const school = realisticSchool(seed);
  const { placed } = placeGreedily(school, seed);
  const r = prng(seed * 13);
  const timeZone = school.school.timeZone;
  const range = periodInstants(
    { from: school.term.startDate, to: school.term.endDate },
    timeZone,
  );
  const lessons: ReportLesson[] = generateLessonOccurrences({
    slots: placed,
    term: school.term,
    holidays: holidaysOfTerm(school.holidays, school.term.id),
    timeZone,
  }).map((o) => ({
    id: `${o.timetableSlotId}@${o.date}`,
    termId: school.term.id,
    groupId: o.groupId,
    teacherId: o.teacherId,
    substituteTeacherId: null,
    roomId: o.roomId,
    startsAt: o.startsAt,
    endsAt: o.endsAt,
    status: "SCHEDULED",
    cancelReason: null,
    rescheduledFromId: null,
  }));
  const groups = new Map<string, ReportGroup>(
    school.groups.map((g) => [
      g.id,
      {
        id: g.id,
        name: g.name,
        type: g.type,
        levelCode: "B1",
        archived: false,
      },
    ]),
  );
  const teacherIds = school.teachers.map((t) => t.id);

  // Memberships: most from the start; some join late or leave mid-term.
  const memberships: ReportMembership[] = school.groups.flatMap((g) =>
    g.studentIds.map((studentId) => {
      const roll = r.next();
      const mid = new Date(range.from.getTime() + r.int(10, 90) * DAY);
      return {
        groupId: g.id,
        studentId,
        joinedAt: roll < 0.1 ? mid : new Date("2026-08-01T00:00:00Z"),
        leftAt: roll > 0.9 ? mid : null,
      };
    }),
  );

  // School cancellations and substitutes.
  for (const l of lessons) {
    const roll = r.next();
    if (roll < 0.03) {
      l.status = "CANCELLED";
      l.cancelReason = r.pick(["HOLIDAY", "TIMETABLE_CHANGED"]);
    } else if (roll < 0.13) {
      l.substituteTeacherId = r.pick(
        teacherIds.filter((t) => t !== l.teacherId),
      );
    } else if (roll < 0.15) {
      l.status = "COMPLETED";
    }
  }

  const absences: ReportAbsence[] = [];
  const replacements: ReportReplacement[] = [];
  const extra: ReportLesson[] = [];
  const membersOf = (l: ReportLesson) =>
    memberships.filter(
      (m) =>
        m.groupId === l.groupId &&
        m.joinedAt <= l.startsAt &&
        (m.leftAt === null || l.startsAt < m.leftAt),
    );
  const moved = (
    from: ReportLesson,
    days: number,
    id: string,
  ): ReportLesson => ({
    ...from,
    id,
    status: "SCHEDULED",
    cancelReason: null,
    substituteTeacherId: null,
    startsAt: new Date(from.startsAt.getTime() + days * DAY),
    endsAt: new Date(from.endsAt.getTime() + days * DAY),
    rescheduledFromId: from.id,
  });

  for (const l of lessons) {
    if (l.status === "CANCELLED") continue;
    const group = groups.get(l.groupId)!;
    for (const m of membersOf(l)) {
      if (r.next() > 0.08) continue;
      const hasCredit = r.next() < 0.6;
      absences.push({ lessonId: l.id, studentId: m.studentId, hasCredit });
      if (group.type === "ONE_ON_ONE" && hasCredit) {
        // Cancelled in time: the 1-on-1 is freed, and maybe rescheduled.
        l.status = "CANCELLED";
        l.cancelReason = "STUDENT_CANCELLED";
        if (r.next() < 0.7) {
          const makeup = moved(l, r.int(1, 6), `${l.id}~m`);
          extra.push(makeup);
          if (r.next() < 0.3) {
            // An admin moved the makeup again: still a makeup.
            makeup.status = "CANCELLED";
            makeup.cancelReason = "RESCHEDULED";
            extra.push(moved(makeup, 1, `${l.id}~m2`));
          }
        }
      } else if (group.type === "GROUP" && hasCredit && r.next() < 0.5) {
        const target = r.pick(
          lessons.filter(
            (x) => x.groupId !== l.groupId && x.startsAt > l.startsAt,
          ),
        );
        if (target) {
          replacements.push({
            studentId: m.studentId,
            targetLessonId: target.id,
            originalGroupId: l.groupId,
            status: r.pick([
              "AUTO_APPROVED",
              "APPROVED",
              "OVERRIDDEN",
              "CANCELLED",
              "REJECTED",
            ]),
          });
        }
      }
    }
  }
  // Admin moves of regular 1-on-1s (no credit): the new lesson is expected.
  for (const l of lessons) {
    if (
      groups.get(l.groupId)!.type === "ONE_ON_ONE" &&
      l.status === "SCHEDULED" &&
      r.next() < 0.05
    ) {
      l.status = "CANCELLED";
      l.cancelReason = "RESCHEDULED";
      extra.push(moved(l, 2, `${l.id}~a`));
    }
  }

  const all = r.shuffle([...lessons, ...extra]);
  const input: AttendanceInput = {
    lessons: all,
    chain: new Map(all.map((l) => [l.id, l])),
    memberships,
    absences,
    replacements,
    groups,
    students: new Map(
      school.students.map((s) => [s.id, { ...s, archived: false }]),
    ),
    range,
    now: NOW,
    filters: {},
  };
  const teachers = new Map(
    school.teachers.map((t) => [t.id, { ...t, archived: false }]),
  );
  return { input, teachers, all, range, r, memberships, absences };
}

describe("reports on realistic schools", () => {
  it.each(SEEDS)(
    "seed %i: teacher hours count every ended lesson exactly once",
    (seed) => {
      const w = world(seed);
      const report = teacherHoursReport({
        lessons: w.all,
        teachers: w.teachers,
        range: w.range,
        now: NOW,
        filters: {},
      });
      const ended = w.all.filter(
        (l) => l.endsAt <= NOW && l.status !== "CANCELLED",
      );
      expect(ended.some((l) => l.substituteTeacherId)).toBe(true);
      for (const row of report.rows) {
        expect(row.totalMinutes, row.teacherId).toBe(
          teachingMinutes(ended, row.teacherId, w.range),
        );
        expect(row.regularMinutes + row.substituteMinutes).toBe(
          row.totalMinutes,
        );
      }
      expect(report.totals.totalMinutes).toBe(
        ended.reduce((sum, l) => sum + lessonMinutes(l), 0),
      );
      expect(report.totals.lessons).toBe(ended.length);
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it.each(SEEDS)(
    "seed %i: attendance rows add up, and no makeup is ever expected",
    (seed) => {
      const w = world(seed);
      const report = attendanceReport(w.input);
      expect(report.rows.length).toBeGreaterThan(100);
      expect(report.totals.makeupsAttended).toBeGreaterThan(0);
      for (const row of report.rows) {
        expect(row.attended + row.absent).toBe(row.expected);
        expect(row.absentWithCredit + row.absentLate).toBe(row.absent);
      }
      // The chain is short on the fixtures; it never hits the step limit.
      for (const l of w.all)
        expect(() => isMakeupLesson(l, w.input.chain)).not.toThrow();
      // Dropping every makeup from the lessons changes no expected count.
      const withoutMakeups = attendanceReport({
        ...w.input,
        lessons: w.all.filter((l) => !isMakeupLesson(l, w.input.chain)),
      });
      const expected = (rows: typeof report.rows) =>
        rows
          .filter((x) => x.expected > 0)
          .map((x) => [x.studentId, x.groupId, x.expected, x.absent]);
      expect(expected(withoutMakeups.rows)).toEqual(expected(report.rows));
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it.each(SEEDS)(
    "seed %i: attended agrees with the ratings rule on member lessons that aren't makeups",
    (seed) => {
      const w = world(seed);
      const pairs = new Set(
        w.all
          .filter((l) => l.endsAt <= NOW)
          .flatMap((l) =>
            w.memberships
              .filter((m) => m.groupId === l.groupId)
              .map((m) => `${m.studentId}|${effectiveTeacher(l)}`),
          ),
      );
      for (const pair of w.r.shuffle([...pairs]).slice(0, 60)) {
        const [studentId, teacherId] = pair.split("|");
        const report = attendanceReport({
          ...w.input,
          filters: { studentId, teacherId },
        });
        const own = w.memberships.filter((m) => m.studentId === studentId);
        const memberLessons = w.all.filter(
          (l) =>
            effectiveTeacher(l) === teacherId &&
            !isMakeupLesson(l, w.input.chain) &&
            own.some(
              (m) =>
                m.groupId === l.groupId &&
                m.joinedAt <= l.startsAt &&
                (m.leftAt === null || l.startsAt < m.leftAt),
            ),
        );
        const attended = attendedLessons(
          {
            memberships: own,
            absentLessonIds: new Set(
              w.absences
                .filter((a) => a.studentId === studentId)
                .map((a) => a.lessonId),
            ),
            replacementLessonIds: new Set(),
          },
          memberLessons,
          NOW,
        );
        expect(
          report.rows.reduce((sum, row) => sum + row.attended, 0),
          pair,
        ).toBe(attended.length);
      }
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});
