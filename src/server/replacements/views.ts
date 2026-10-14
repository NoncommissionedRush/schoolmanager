// Read models for absences and makeup credits (docs/design/absences.md §5.4,
// §6.1, §7.2, §7.5). Authorization lives in the callers' contexts: every
// function runs on the school-scoped client, student functions take the
// signed-in student's own profile id, and the lesson roster is only loaded
// for a lesson the caller may already open. Student DTOs never carry other
// students' names.

import type { Prisma } from "@/generated/prisma/client";
import { pageWindow } from "@/server/admin/list";
import {
  addDays,
  buildRoster,
  creditExpiry,
  creditState,
  cutoffAt,
  daysLeft,
  type IsoDate,
  STUDENT_CANCELLED,
  toZonedDateTime,
  validUntilOf,
  zonedTimeToUtc,
} from "@/server/scheduling";
import type { SchoolDb } from "@/server/timetable/service";
import {
  isMemberAt,
  membersAt,
  type StudentAttendance,
} from "@/server/timetable/week";

export type { StudentAttendance };

import { ACTIVE_REPLACEMENT } from "./service";

/** The school's absence settings, as the student policy line shows them. */
export async function loadAbsenceSettings(db: SchoolDb) {
  const school = await db.school.findFirstOrThrow({
    select: {
      timezone: true,
      absenceCutoffMinutes: true,
      makeupCreditValidDays: true,
    },
  });
  return {
    timeZone: school.timezone,
    absenceCutoffMinutes: school.absenceCutoffMinutes,
    makeupCreditValidDays: school.makeupCreditValidDays,
  };
}

type LessonTimes = { date: IsoDate; startMinute: number; endMinute: number };

function times(
  lesson: { startsAt: Date; endsAt: Date },
  timeZone: string,
): LessonTimes {
  const start = toZonedDateTime(lesson.startsAt, timeZone);
  const end = toZonedDateTime(lesson.endsAt, timeZone);
  return {
    date: start.date,
    startMinute: start.minute,
    endMinute: end.date === start.date ? end.minute : 24 * 60,
  };
}

// ---------------------------------------------------------------------------
// Student: what a lesson's "Can't attend?" needs (§5.1)
// ---------------------------------------------------------------------------

/**
 * Attendance info for the student's own lessons, keyed by lesson id. Only
 * reads the student's own reports.
 */
export async function loadStudentAttendance(
  db: SchoolDb,
  student: { id: string; userId: string },
  lessons: readonly { id: string; startsAt: Date }[],
): Promise<Map<string, StudentAttendance>> {
  const out = new Map<string, StudentAttendance>();
  if (lessons.length === 0) return out;
  const [settings, reports] = await Promise.all([
    loadAbsenceSettings(db),
    db.absenceReport.findMany({
      where: {
        studentId: student.id,
        lessonId: { in: lessons.map((l) => l.id) },
      },
      select: {
        lessonId: true,
        createdAt: true,
        reportedById: true,
        makeupCredit: { select: { id: true } },
      },
    }),
  ]);
  const byLesson = new Map(reports.map((r) => [r.lessonId, r]));
  for (const lesson of lessons) {
    const report = byLesson.get(lesson.id);
    out.set(lesson.id, {
      cutoffAt: cutoffAt(
        lesson.startsAt,
        settings.absenceCutoffMinutes,
      ).toISOString(),
      cutoffMinutes: settings.absenceCutoffMinutes,
      creditValidUntil: creditExpiry(
        lesson.startsAt,
        settings.makeupCreditValidDays,
        settings.timeZone,
      ).validUntil,
      cancelled: report
        ? {
            at: report.createdAt.toISOString(),
            byOffice: report.reportedById !== student.userId,
            credit: report.makeupCredit !== null,
          }
        : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Student: Absences & credits tab (§5.4)
// ---------------------------------------------------------------------------

const creditSelect = {
  id: true,
  status: true,
  expiresAt: true,
  sourceLesson: {
    select: {
      startsAt: true,
      endsAt: true,
      group: { select: { name: true, type: true } },
      teacher: { select: { user: { select: { name: true } } } },
    },
  },
} satisfies Prisma.MakeupCreditSelect;

export type StudentCredit = {
  id: string;
  sourceDate: IsoDate;
  groupName: string;
  oneOnOne: boolean;
  teacherName: string;
  validUntil: IsoDate;
  /** Local days left until the last valid day (0 = last day today). */
  daysLeft: number;
};

export type StudentCancellation = LessonTimes & {
  id: string;
  lessonId: string;
  groupName: string;
  oneOnOne: boolean;
  teacherName: string;
  credit: boolean;
  byOffice: boolean;
  reportedAt: string;
};

export type StudentHistoryItem =
  | {
      kind: "creditUsed" | "creditExpired";
      id: string;
      sourceDate: IsoDate;
      groupName: string;
      /** The day the credit expired (first day it was no longer valid). */
      expiredOn: IsoDate;
    }
  | {
      kind: "cancelledNoCredit";
      id: string;
      sourceDate: IsoDate;
      groupName: string;
    };

export type StudentAbsences = {
  policy: { hours: number; days: number };
  credits: StudentCredit[];
  upcoming: StudentCancellation[];
  history: StudentHistoryItem[];
  historyCount: number;
};

/** History rows shown per "Load more" (§5.4). */
export const HISTORY_PAGE = 20;

/**
 * The student's Absences tab: available credits (soonest expiry first),
 * upcoming cancellations (soonest first) and history (newest first, the
 * first `shownHistory`).
 */
export async function loadStudentAbsences(
  db: SchoolDb,
  student: { id: string; userId: string },
  options: { shownHistory: number },
  now: Date,
): Promise<StudentAbsences> {
  const settings = await loadAbsenceSettings(db);
  const tz = settings.timeZone;
  const [credits, reports] = await Promise.all([
    db.makeupCredit.findMany({
      where: { studentId: student.id },
      select: creditSelect,
    }),
    db.absenceReport.findMany({
      where: { studentId: student.id },
      select: {
        id: true,
        createdAt: true,
        reportedById: true,
        makeupCredit: { select: { id: true } },
        lesson: {
          select: {
            id: true,
            startsAt: true,
            endsAt: true,
            group: { select: { name: true, type: true } },
            teacher: { select: { user: { select: { name: true } } } },
          },
        },
      },
    }),
  ]);

  const available: StudentCredit[] = [];
  const history: { item: StudentHistoryItem; sortAt: number }[] = [];
  for (const credit of credits) {
    const source = credit.sourceLesson;
    const sourceDate = toZonedDateTime(source.startsAt, tz).date;
    const state = creditState(credit, now);
    if (state === "AVAILABLE") {
      available.push({
        id: credit.id,
        sourceDate,
        groupName: source.group.name,
        oneOnOne: source.group.type === "ONE_ON_ONE",
        teacherName: source.teacher.user.name,
        validUntil: validUntilOf(credit.expiresAt, tz),
        daysLeft: daysLeft(credit.expiresAt, now, tz),
      });
    } else {
      history.push({
        item: {
          kind: state === "USED" ? "creditUsed" : "creditExpired",
          id: credit.id,
          sourceDate,
          groupName: source.group.name,
          expiredOn: toZonedDateTime(credit.expiresAt, tz).date,
        },
        sortAt: source.startsAt.getTime(),
      });
    }
  }
  available.sort(
    (a, b) =>
      a.validUntil.localeCompare(b.validUntil) || a.id.localeCompare(b.id),
  );

  const upcoming: StudentCancellation[] = [];
  for (const report of reports) {
    const { lesson } = report;
    if (lesson.startsAt > now) {
      upcoming.push({
        id: report.id,
        lessonId: lesson.id,
        ...times(lesson, tz),
        groupName: lesson.group.name,
        oneOnOne: lesson.group.type === "ONE_ON_ONE",
        teacherName: lesson.teacher.user.name,
        credit: report.makeupCredit !== null,
        byOffice: report.reportedById !== student.userId,
        reportedAt: report.createdAt.toISOString(),
      });
    } else if (!report.makeupCredit) {
      // Past cancellations with a credit show through the credit.
      history.push({
        item: {
          kind: "cancelledNoCredit",
          id: report.id,
          sourceDate: toZonedDateTime(lesson.startsAt, tz).date,
          groupName: lesson.group.name,
        },
        sortAt: lesson.startsAt.getTime(),
      });
    }
  }
  upcoming.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.startMinute - b.startMinute ||
      a.id.localeCompare(b.id),
  );
  history.sort(
    (a, b) => b.sortAt - a.sortAt || a.item.id.localeCompare(b.item.id),
  );

  return {
    policy: {
      hours: Math.floor(settings.absenceCutoffMinutes / 60),
      days: settings.makeupCreditValidDays,
    },
    credits: available,
    upcoming,
    history: history.slice(0, options.shownHistory).map((h) => h.item),
    historyCount: history.length,
  };
}

/** Available credits of the student, for the home card (§5.4). */
export async function loadStudentCreditSummary(
  db: SchoolDb,
  studentId: string,
  now: Date,
): Promise<{ count: number; soonest: IsoDate | null }> {
  const settings = await loadAbsenceSettings(db);
  const credits = await db.makeupCredit.findMany({
    where: { studentId, status: "AVAILABLE", expiresAt: { gt: now } },
    select: { expiresAt: true },
    orderBy: { expiresAt: "asc" },
  });
  return {
    count: credits.length,
    soonest: credits[0]
      ? validUntilOf(credits[0].expiresAt, settings.timeZone)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Teacher / admin lesson page: Students card (§6.1)
// ---------------------------------------------------------------------------

export type LessonRosterView = {
  lessonId: string;
  oneOnOne: boolean;
  /** Cancelled by the school (holiday, timetable change): no card. */
  schoolCancelled: boolean;
  room: { name: string; capacity: number | null } | null;
  coming: { id: string; name: string; replacementFrom: string | null }[];
  notComing: {
    id: string;
    name: string;
    reportedAt: string;
    reason: string | null;
    viaOffice: boolean;
    late: boolean;
  }[];
  seatsTaken: number;
  /** A 1-on-1 the student cancelled: who, and why. */
  oneOnOneCancelled: { name: string; reason: string | null } | null;
  /** Admins can report an absence for a coming member now. */
  reportable: boolean;
};

/**
 * The Students card of a lesson the caller may already open (teacher or
 * admin; never call this for students: it lists classmates).
 */
export async function loadLessonRoster(
  db: SchoolDb,
  lessonId: string,
  now: Date,
): Promise<LessonRosterView | null> {
  const lesson = await db.lesson.findFirst({
    where: { id: lessonId },
    select: {
      id: true,
      startsAt: true,
      status: true,
      cancelReason: true,
      term: { select: { timetablePublishedAt: true } },
      room: { select: { name: true, capacity: true } },
      group: {
        select: {
          type: true,
          memberships: {
            select: {
              joinedAt: true,
              leftAt: true,
              student: {
                select: {
                  id: true,
                  userId: true,
                  user: { select: { name: true } },
                },
              },
            },
          },
        },
      },
      absenceReports: {
        select: {
          studentId: true,
          createdAt: true,
          reason: true,
          reportedById: true,
          makeupCredit: { select: { id: true } },
          student: {
            select: { userId: true, user: { select: { name: true } } },
          },
        },
      },
      replacementsTo: {
        where: { status: { in: [...ACTIVE_REPLACEMENT] } },
        select: {
          student: { select: { id: true, user: { select: { name: true } } } },
          originalLesson: { select: { group: { select: { name: true } } } },
        },
      },
    },
  });
  if (!lesson) return null;
  const members = membersAt(lesson.group.memberships, lesson.startsAt).map(
    (m) => ({ id: m.student.id, name: m.student.user.name }),
  );
  const roster = buildRoster({
    members,
    absences: lesson.absenceReports.map((a) => ({
      studentId: a.studentId,
      reportedAt: a.createdAt,
      reason: a.reason,
      viaOffice: a.reportedById !== a.student.userId,
      hasCredit: a.makeupCredit !== null,
    })),
    replacements: lesson.replacementsTo.map((r) => ({
      id: r.student.id,
      name: r.student.user.name,
      fromGroup: r.originalLesson.group.name,
    })),
  });
  const oneOnOne = lesson.group.type === "ONE_ON_ONE";
  const studentCancelled =
    oneOnOne && lesson.cancelReason === STUDENT_CANCELLED
      ? lesson.absenceReports[0]
      : undefined;
  return {
    lessonId: lesson.id,
    oneOnOne,
    schoolCancelled:
      lesson.status === "CANCELLED" &&
      lesson.cancelReason !== STUDENT_CANCELLED,
    room: lesson.room,
    coming: roster.coming,
    notComing: roster.notComing.map((s) => ({
      ...s,
      reportedAt: s.reportedAt.toISOString(),
    })),
    seatsTaken: roster.seatsTaken,
    oneOnOneCancelled: studentCancelled
      ? {
          name: studentCancelled.student.user.name,
          reason: studentCancelled.reason,
        }
      : null,
    reportable:
      lesson.status === "SCHEDULED" &&
      lesson.startsAt > now &&
      lesson.term.timetablePublishedAt !== null,
  };
}

// ---------------------------------------------------------------------------
// Admin: Absences list (§7.2) and Report absence dialog (§7.5)
// ---------------------------------------------------------------------------

export type AdminAbsenceFilters = {
  from: IsoDate;
  to: IsoDate;
  studentId?: string;
  groupId?: string;
  teacherId?: string;
  page: number;
};

/** The Absences tab's default period: last 7 and next 14 days (§7.2). */
export function defaultAbsencePeriod(today: IsoDate) {
  return { from: addDays(today, -7), to: addDays(today, 14) };
}

export type AdminAbsenceRow = {
  id: string;
  lesson: LessonTimes & {
    id: string;
    groupName: string;
    oneOnOne: boolean;
    started: boolean;
  };
  student: { id: string; name: string };
  reportedAt: string;
  /** Name of the admin who reported it; null when the student did. */
  byAdmin: string | null;
  reason: string | null;
  credit: {
    state: "AVAILABLE" | "USED" | "EXPIRED";
    validUntil: IsoDate;
  } | null;
};

export async function listAdminAbsences(
  db: SchoolDb,
  filters: AdminAbsenceFilters,
  now: Date,
) {
  const { timeZone } = await loadAbsenceSettings(db);
  const where: Prisma.AbsenceReportWhereInput = {
    ...(filters.studentId && { studentId: filters.studentId }),
    lesson: {
      startsAt: {
        gte: zonedTimeToUtc(filters.from, 0, timeZone),
        lt: zonedTimeToUtc(addDays(filters.to, 1), 0, timeZone),
      },
      ...(filters.groupId && { groupId: filters.groupId }),
      ...(filters.teacherId && {
        OR: [
          { teacherId: filters.teacherId },
          { substituteTeacherId: filters.teacherId },
        ],
      }),
    },
  };
  const total = await db.absenceReport.count({ where });
  const window = pageWindow(filters.page, total);
  const rows = await db.absenceReport.findMany({
    where,
    orderBy: [{ lesson: { startsAt: "asc" } }, { id: "asc" }],
    skip: window.skip,
    take: window.take,
    select: {
      id: true,
      createdAt: true,
      reason: true,
      reportedById: true,
      reportedBy: { select: { name: true } },
      student: {
        select: { id: true, userId: true, user: { select: { name: true } } },
      },
      makeupCredit: { select: { status: true, expiresAt: true } },
      lesson: {
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          group: { select: { name: true, type: true } },
        },
      },
    },
  });
  return {
    total,
    window,
    rows: rows.map((row): AdminAbsenceRow => ({
      id: row.id,
      lesson: {
        id: row.lesson.id,
        ...times(row.lesson, timeZone),
        groupName: row.lesson.group.name,
        oneOnOne: row.lesson.group.type === "ONE_ON_ONE",
        started: row.lesson.startsAt <= now,
      },
      student: { id: row.student.id, name: row.student.user.name },
      reportedAt: row.createdAt.toISOString(),
      byAdmin:
        row.reportedById && row.reportedById !== row.student.userId
          ? (row.reportedBy?.name ?? null)
          : null,
      reason: row.reason,
      credit: row.makeupCredit && {
        state: creditState(row.makeupCredit, now),
        validUntil: validUntilOf(row.makeupCredit.expiresAt, timeZone),
      },
    })),
  };
}

/** Filter and picker options for the admin list and dialog. */
export async function loadAbsenceFilterOptions(db: SchoolDb) {
  const [students, groups, teachers] = await Promise.all([
    db.studentProfile.findMany({
      select: { id: true, user: { select: { name: true, deletedAt: true } } },
      orderBy: { user: { name: "asc" } },
    }),
    db.group.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.teacherProfile.findMany({
      select: { id: true, user: { select: { name: true } } },
      orderBy: { user: { name: "asc" } },
    }),
  ]);
  return {
    students: students.map((s) => ({
      id: s.id,
      name: s.user.name,
      archived: s.user.deletedAt !== null,
    })),
    groups,
    teachers: teachers.map((t) => ({ id: t.id, name: t.user.name })),
  };
}

/** How far ahead the Report absence dialog lists lessons (§7.5). */
export const REPORTABLE_DAYS = 30;

export type ReportableLesson = LessonTimes & {
  id: string;
  groupName: string;
  oneOnOne: boolean;
  teacherName: string;
  cutoffAt: string;
  creditValidUntil: IsoDate;
  alreadyCancelled: boolean;
};

/**
 * The student's upcoming lessons an admin can report an absence for: of
 * groups they are a member of then, published, scheduled, not started,
 * within the next 30 days. Lessons they attend as a replacement aren't
 * listed (reject the replacement instead).
 */
export async function listReportableLessons(
  db: SchoolDb,
  studentId: string,
  now: Date,
): Promise<{
  student: { id: string; name: string };
  lessons: ReportableLesson[];
} | null> {
  const [settings, student] = await Promise.all([
    loadAbsenceSettings(db),
    db.studentProfile.findFirst({
      where: { id: studentId },
      select: {
        id: true,
        user: { select: { name: true } },
        groupMemberships: {
          select: { groupId: true, joinedAt: true, leftAt: true },
        },
      },
    }),
  ]);
  if (!student) return null;
  const memberships = student.groupMemberships;
  const groupIds = [...new Set(memberships.map((m) => m.groupId))];
  const rows = await db.lesson.findMany({
    where: {
      groupId: { in: groupIds },
      status: "SCHEDULED",
      startsAt: {
        gt: now,
        lt: new Date(now.getTime() + REPORTABLE_DAYS * 86_400_000),
      },
      term: { timetablePublishedAt: { not: null } },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      groupId: true,
      startsAt: true,
      endsAt: true,
      group: { select: { name: true, type: true } },
      teacher: { select: { user: { select: { name: true } } } },
      absenceReports: { where: { studentId }, select: { id: true } },
    },
  });
  return {
    student: { id: student.id, name: student.user.name },
    lessons: rows
      .filter((row) => isMemberAt(memberships, row.groupId, row.startsAt))
      .map((row) => ({
        id: row.id,
        ...times(row, settings.timeZone),
        groupName: row.group.name,
        oneOnOne: row.group.type === "ONE_ON_ONE",
        teacherName: row.teacher.user.name,
        cutoffAt: cutoffAt(
          row.startsAt,
          settings.absenceCutoffMinutes,
        ).toISOString(),
        creditValidUntil: creditExpiry(
          row.startsAt,
          settings.makeupCreditValidDays,
          settings.timeZone,
        ).validUntil,
        alreadyCancelled: row.absenceReports.length > 0,
      })),
  };
}
