// The report loaders (docs/architecture/phase6-rules.md §2–§5): load the
// rows of one school and hand them to the pure builders in `rules.ts`.
// ADMIN ONLY. Callers go through `admin.ts`, which checks the role first;
// the import guard in reports.test.ts allows importing this file only from
// src/app/admin/**, src/app/api/admin/reports/** and src/server/reports/**.

import { toIsoDate, toZonedDateTime } from "@/server/scheduling";
import type { SchoolDb } from "@/server/timetable/service";

import {
  ACTIVE_REPLACEMENT_STATUSES,
  type AttendanceReport,
  attendanceReport,
  checkRowLimit,
  MAKEUP_CHAIN_MAX,
  periodInstants,
  type Period,
  reachesPastNow,
  ReportError,
  type ReportGroup,
  type ReportKind,
  type ReportLesson,
  type ReportPerson,
  type ReportTerm,
  resolvePeriod,
  type TeacherHoursReport,
  teacherHoursLessons,
  teacherHoursReport,
  type TeacherHoursRow,
  type TeacherLessonRow,
} from "./rules";
import type { ReportInput } from "./schema";

export type ReportOptions = {
  /** Every term of the school, newest first. */
  terms: (ReportTerm & { published: boolean })[];
  teachers: ReportPerson[];
  groups: ReportGroup[];
  students: ReportPerson[];
};

export type ReportResults = {
  attendance: AttendanceReport;
  "teacher-hours": TeacherHoursReport;
  "teacher-hours-lessons": {
    rows: TeacherLessonRow[];
    /** The filtered teacher's summary row (null without `teacherId`). */
    summary: TeacherHoursRow | null;
    teacher: ReportPerson | null;
  };
};

/** Range errors the page shows inline (§2); the CSV answers 422. */
export type ReportRangeError = "RANGE_TOO_LONG" | "INVALID_RANGE" | "NO_TERM";

export type LoadedReport<K extends ReportKind> = {
  report: K;
  timeZone: string;
  /** "Data as of" (§2): reports read the data as it is now. */
  asOf: Date;
  options: ReportOptions;
} & (
  | {
      status: "ok";
      period: Period;
      /** The period reaches past now: only lessons until now count. */
      untilToday: boolean;
      result: ReportResults[K];
    }
  | { status: "error"; code: ReportRangeError }
);

const byName = (a: { name: string; id: string }, b: typeof a) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** Teachers or students by profile id, archived ones included (§2). */
async function loadPeople(
  db: SchoolDb,
  role: "TEACHER" | "STUDENT",
): Promise<ReportPerson[]> {
  const select = {
    id: true,
    userId: true,
    user: { select: { name: true, deletedAt: true } },
  } as const;
  const profiles =
    role === "TEACHER"
      ? await db.teacherProfile.findMany({ select })
      : await db.studentProfile.findMany({ select });
  const current = new Set(
    (
      await db.membership.findMany({
        where: { role, userId: { in: profiles.map((p) => p.userId) } },
        select: { userId: true },
      })
    ).map((m) => m.userId),
  );
  return profiles
    .map((p) => ({
      id: p.id,
      name: p.user.name,
      archived: !!p.user.deletedAt || !current.has(p.userId),
    }))
    .sort(byName);
}

async function loadOptions(db: SchoolDb): Promise<ReportOptions> {
  const [terms, groups, teachers, students] = await Promise.all([
    db.term.findMany({
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        timetablePublishedAt: true,
      },
      orderBy: [{ startDate: "desc" }, { id: "asc" }],
    }),
    db.group.findMany({
      select: {
        id: true,
        name: true,
        type: true,
        deletedAt: true,
        level: { select: { code: true } },
      },
    }),
    loadPeople(db, "TEACHER"),
    loadPeople(db, "STUDENT"),
  ]);
  return {
    terms: terms.map((t) => ({
      id: t.id,
      name: t.name,
      startDate: toIsoDate(t.startDate),
      endDate: toIsoDate(t.endDate),
      published: t.timetablePublishedAt !== null,
    })),
    groups: groups
      .map((g) => ({
        id: g.id,
        name: g.name,
        type: g.type,
        levelCode: g.level.code,
        archived: g.deletedAt !== null,
      }))
      .sort(byName),
    teachers,
    students,
  };
}

const LESSON_SELECT = {
  id: true,
  termId: true,
  groupId: true,
  teacherId: true,
  substituteTeacherId: true,
  roomId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  cancelReason: true,
  rescheduledFromId: true,
} as const;

/**
 * Every lesson by id: `lessons` and their reschedule ancestors, whatever
 * their term or date, so `isMakeupLesson` can follow the chain (§3.2).
 */
async function withAncestors(
  db: SchoolDb,
  lessons: readonly ReportLesson[],
): Promise<Map<string, ReportLesson>> {
  const chain = new Map(lessons.map((l) => [l.id, l]));
  let missing = lessons;
  for (let step = 0; step < MAKEUP_CHAIN_MAX; step++) {
    const ids = [
      ...new Set(
        missing.flatMap((l) =>
          l.rescheduledFromId && !chain.has(l.rescheduledFromId)
            ? [l.rescheduledFromId]
            : [],
        ),
      ),
    ];
    if (ids.length === 0) break;
    missing = await db.lesson.findMany({
      where: { id: { in: ids } },
      select: LESSON_SELECT,
    });
    for (const l of missing) chain.set(l.id, l);
  }
  return chain;
}

async function buildAttendance(
  db: SchoolDb,
  lessons: ReportLesson[],
  options: ReportOptions,
  input: ReportInput,
  range: { from: Date; to: Date },
  now: Date,
): Promise<AttendanceReport> {
  const lessonIds = lessons.map((l) => l.id);
  const [chain, memberships, absences, replacements] = await Promise.all([
    withAncestors(db, lessons),
    db.groupMembership.findMany({
      where: { groupId: { in: [...new Set(lessons.map((l) => l.groupId))] } },
      select: { groupId: true, studentId: true, joinedAt: true, leftAt: true },
    }),
    db.absenceReport.findMany({
      where: { lessonId: { in: lessonIds } },
      select: {
        lessonId: true,
        studentId: true,
        makeupCredit: { select: { id: true } },
      },
    }),
    db.replacementRequest.findMany({
      where: {
        targetLessonId: { in: lessonIds },
        status: { in: [...ACTIVE_REPLACEMENT_STATUSES] },
      },
      select: {
        studentId: true,
        targetLessonId: true,
        status: true,
        originalLesson: { select: { groupId: true } },
      },
    }),
  ]);
  return attendanceReport({
    lessons,
    chain,
    memberships,
    absences: absences.map((a) => ({
      lessonId: a.lessonId,
      studentId: a.studentId,
      hasCredit: a.makeupCredit !== null,
    })),
    replacements: replacements.map((r) => ({
      studentId: r.studentId,
      targetLessonId: r.targetLessonId,
      originalGroupId: r.originalLesson.groupId,
      status: r.status,
    })),
    groups: new Map(options.groups.map((g) => [g.id, g])),
    students: new Map(options.students.map((s) => [s.id, s])),
    range,
    now,
    filters: input,
  });
}

/**
 * Loads one report for the school of `db` (§2). Filter ids of another
 * school, or unknown ones, throw `NOT_FOUND`; a bad period or a school
 * without terms is `status: "error"` so the page can still show its
 * filters. Only ended lessons of published terms count.
 */
export async function loadReportData<K extends ReportKind>(
  db: SchoolDb,
  report: K,
  input: ReportInput,
  now: Date,
): Promise<LoadedReport<K>> {
  const [school, options] = await Promise.all([
    db.school.findFirstOrThrow({ select: { timezone: true } }),
    loadOptions(db),
  ]);
  const has = (list: { id: string }[], id: string | undefined) =>
    id === undefined || list.some((x) => x.id === id);
  if (
    !has(options.terms, input.termId) ||
    !has(options.teachers, input.teacherId) ||
    !has(options.groups, input.groupId) ||
    !has(options.students, input.studentId)
  ) {
    throw new ReportError("NOT_FOUND");
  }
  const base = { report, timeZone: school.timezone, asOf: now, options };

  let period: Period;
  try {
    period = resolvePeriod(
      input,
      options.terms,
      toZonedDateTime(now, school.timezone).date,
    );
  } catch (error) {
    if (
      error instanceof ReportError &&
      (error.code === "RANGE_TOO_LONG" ||
        error.code === "INVALID_RANGE" ||
        error.code === "NO_TERM")
    ) {
      return { ...base, status: "error", code: error.code };
    }
    throw error;
  }
  const range = periodInstants(period, school.timezone);
  const lessons: ReportLesson[] = await db.lesson.findMany({
    where: {
      startsAt: { gte: range.from, lt: range.to },
      endsAt: { lte: now },
      term: { timetablePublishedAt: { not: null } },
    },
    select: LESSON_SELECT,
  });
  const teachers = new Map(options.teachers.map((t) => [t.id, t]));
  const hoursInput = {
    lessons,
    teachers,
    range,
    now,
    filters: { teacherId: input.teacherId, groupId: input.groupId },
  };

  let result: ReportResults[ReportKind];
  if (report === "attendance") {
    result = await buildAttendance(db, lessons, options, input, range, now);
  } else if (report === "teacher-hours") {
    result = teacherHoursReport(hoursInput);
  } else {
    const rooms = await db.room.findMany({ select: { id: true, name: true } });
    result = {
      rows: teacherHoursLessons({
        ...hoursInput,
        groups: new Map(options.groups.map((g) => [g.id, g])),
        rooms: new Map(rooms.map((r) => [r.id, r.name])),
        timeZone: school.timezone,
      }),
      summary: input.teacherId
        ? (teacherHoursReport(hoursInput).rows[0] ?? null)
        : null,
      teacher: input.teacherId ? teachers.get(input.teacherId)! : null,
    };
  }
  return {
    ...base,
    status: "ok",
    period,
    untilToday: reachesPastNow(range, now),
    result: result as ReportResults[K],
  };
}

export type ReportExport<K extends ReportKind> = {
  report: K;
  period: Period;
  rows: ReportResults[K]["rows"];
};

/**
 * The rows of a CSV export (§5): the page's loader, then the row limit
 * (`TOO_MANY_ROWS` with the count) and the `report.exported` audit entry.
 * Range errors throw their code.
 */
export async function exportReportData<K extends ReportKind>(
  db: SchoolDb,
  actor: { userId: string; schoolId: string },
  report: K,
  input: ReportInput,
  now: Date,
): Promise<ReportExport<K>> {
  const loaded = await loadReportData(db, report, input, now);
  if (loaded.status === "error") throw new ReportError(loaded.code);
  const rows = loaded.result.rows as ReportResults[K]["rows"];
  checkRowLimit(rows.length);
  await db.auditLog.create({
    data: {
      schoolId: actor.schoolId,
      actorId: actor.userId,
      action: "report.exported",
      entityType: "School",
      entityId: actor.schoolId,
      data: { report, input, rows: rows.length },
    },
  });
  return { report, period: loaded.period, rows };
}
