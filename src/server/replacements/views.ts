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
  RESCHEDULED,
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

import { ACTIVE_REPLACEMENT } from "./release";

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

/** The first lesson of a reschedule chain (the lesson made up for). */
async function rescheduleRoot(
  db: SchoolDb,
  lesson: { startsAt: Date; rescheduledFromId: string | null },
) {
  let current = lesson;
  for (let i = 0; i < 1_000 && current.rescheduledFromId; i++) {
    const previous = await db.lesson.findFirst({
      where: { id: current.rescheduledFromId },
      select: { startsAt: true, rescheduledFromId: true },
    });
    if (!previous) break;
    current = previous;
  }
  return current;
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
  now: Date = new Date(),
): Promise<Map<string, StudentAttendance>> {
  const out = new Map<string, StudentAttendance>();
  if (lessons.length === 0) return out;
  const lessonIds = lessons.map((l) => l.id);
  const creditInfo = {
    status: true,
    expiresAt: true,
    sourceLesson: { select: { startsAt: true } },
  } satisfies Prisma.MakeupCreditSelect;
  const [settings, reports, bookings, moved] = await Promise.all([
    loadAbsenceSettings(db),
    db.absenceReport.findMany({
      where: { studentId: student.id, lessonId: { in: lessonIds } },
      select: {
        lessonId: true,
        createdAt: true,
        reportedById: true,
        makeupCredit: { select: { id: true } },
      },
    }),
    db.replacementRequest.findMany({
      where: {
        studentId: student.id,
        targetLessonId: { in: lessonIds },
        status: { in: [...ACTIVE_REPLACEMENT] },
      },
      select: {
        id: true,
        targetLessonId: true,
        originalLesson: { select: { startsAt: true } },
        makeupCredit: { select: creditInfo },
      },
    }),
    // Rescheduled 1-on-1s (ad-hoc lessons of their own group).
    db.lesson.findMany({
      where: { id: { in: lessonIds }, rescheduledFromId: { not: null } },
      select: {
        id: true,
        startsAt: true,
        rescheduledFromId: true,
        spentCredit: { select: creditInfo },
      },
    }),
  ]);
  const tz = settings.timeZone;
  const localDate = (instant: Date) => toZonedDateTime(instant, tz).date;
  const creditOf = (credit: {
    status: "AVAILABLE" | "USED" | "EXPIRED";
    expiresAt: Date;
    sourceLesson: { startsAt: Date };
  }) => ({
    sourceDate: localDate(credit.sourceLesson.startsAt),
    validUntil: validUntilOf(credit.expiresAt, tz),
    expired: now.getTime() >= credit.expiresAt.getTime(),
  });
  const byLesson = new Map(reports.map((r) => [r.lessonId, r]));
  const bookingOf = new Map<string, StudentAttendance["booking"]>();
  // An admin-moved 1-on-1 earns a credit valid from its chain root (§3).
  const anchorOf = new Map<string, Date>();
  for (const b of bookings) {
    bookingOf.set(b.targetLessonId, {
      kind: "replacement",
      bookingId: b.id,
      originalDate: localDate(b.originalLesson.startsAt),
      credit: creditOf(b.makeupCredit),
    });
  }
  for (const lesson of moved) {
    const root = await rescheduleRoot(db, lesson);
    anchorOf.set(lesson.id, root.startsAt);
    bookingOf.set(lesson.id, {
      kind: "rescheduled",
      bookingId: null,
      originalDate: localDate(root.startsAt),
      credit:
        lesson.spentCredit?.status === "USED"
          ? creditOf(lesson.spentCredit)
          : null,
    });
  }
  for (const lesson of lessons) {
    const report = byLesson.get(lesson.id);
    out.set(lesson.id, {
      cutoffAt: cutoffAt(
        lesson.startsAt,
        settings.absenceCutoffMinutes,
      ).toISOString(),
      cutoffMinutes: settings.absenceCutoffMinutes,
      creditValidUntil: creditExpiry(
        anchorOf.get(lesson.id) ?? lesson.startsAt,
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
      booking: bookingOf.get(lesson.id) ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Student: Absences & credits tab (§5.4)
// ---------------------------------------------------------------------------

const usedOnSelect = {
  startsAt: true,
  endsAt: true,
  group: { select: { name: true } },
} satisfies Prisma.LessonSelect;

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
  // What a USED credit is spent on, for the history line.
  rescheduledLesson: { select: usedOnSelect },
  replacements: {
    where: { status: { in: [...ACTIVE_REPLACEMENT] } },
    select: { targetLesson: { select: usedOnSelect } },
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
      /** What a used credit was spent on. */
      usedFor: {
        kind: "replacement" | "rescheduled";
        groupName: string;
        date: IsoDate;
        startMinute: number;
      } | null;
    }
  | {
      kind: "cancelledNoCredit";
      id: string;
      sourceDate: IsoDate;
      groupName: string;
    }
  | {
      /** A booking the school rejected or that its lesson's cancellation released. */
      kind: "removedBySchool";
      id: string;
      sourceDate: IsoDate;
      groupName: string;
      reason: string | null;
      lessonCancelled: boolean;
    };

/** A replacement or rescheduled 1-on-1 that hasn't started (§5.4). */
export type StudentUpcomingBooking = LessonTimes & {
  kind: "replacement" | "rescheduled";
  /** Replacement booking id; null for a rescheduled lesson. */
  bookingId: string | null;
  lessonId: string;
  groupName: string;
  oneOnOne: boolean;
  teacherName: string;
  startsAt: string;
  originalDate: IsoDate;
  /** Last instant cancelling gives the credit back. */
  cutoffAt: string;
  credit: { sourceDate: IsoDate; validUntil: IsoDate; expired: boolean } | null;
  /** The school overrode the booking ("Changed by school") and why. */
  changedBySchool: string | null;
  /** "Valid until" of what cancelling in time gives (rescheduled 1-on-1). */
  creditValidUntil: IsoDate;
};

export type StudentAbsences = {
  policy: { hours: number; days: number; cutoffMinutes: number };
  credits: StudentCredit[];
  bookings: StudentUpcomingBooking[];
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
  const cutoffMs = settings.absenceCutoffMinutes * 60_000;
  const [credits, reports, replacements, rescheduled] = await Promise.all([
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
    db.replacementRequest.findMany({
      where: { studentId: student.id, status: { not: "CANCELLED" } },
      select: {
        id: true,
        status: true,
        cancelReason: true,
        reviewNote: true,
        originalLesson: { select: { startsAt: true } },
        makeupCredit: {
          select: {
            expiresAt: true,
            sourceLesson: { select: { startsAt: true } },
          },
        },
        targetLesson: {
          select: {
            id: true,
            startsAt: true,
            endsAt: true,
            group: { select: { name: true } },
            teacher: { select: { user: { select: { name: true } } } },
          },
        },
      },
    }),
    // Their rescheduled 1-on-1s that haven't started: a credit is spent on
    // them, or an admin moved them.
    db.lesson.findMany({
      where: {
        rescheduledFromId: { not: null },
        status: "SCHEDULED",
        startsAt: { gt: now },
        group: {
          type: "ONE_ON_ONE",
          memberships: { some: { studentId: student.id } },
        },
      },
      select: {
        id: true,
        groupId: true,
        startsAt: true,
        endsAt: true,
        rescheduledFromId: true,
        group: { select: { name: true } },
        teacher: { select: { user: { select: { name: true } } } },
        spentCredit: {
          select: {
            studentId: true,
            expiresAt: true,
            sourceLesson: { select: { startsAt: true } },
          },
        },
      },
    }),
  ]);
  const local = (instant: Date) => toZonedDateTime(instant, tz).date;

  const bookings: StudentUpcomingBooking[] = [];
  const history: { item: StudentHistoryItem; sortAt: number }[] = [];
  for (const r of replacements) {
    const target = r.targetLesson;
    if (r.status === "REJECTED") {
      history.push({
        item: {
          kind: "removedBySchool",
          id: r.id,
          sourceDate: local(target.startsAt),
          groupName: target.group.name,
          reason: r.reviewNote,
          lessonCancelled: false,
        },
        sortAt: target.startsAt.getTime(),
      });
      continue;
    }
    if (target.startsAt <= now) continue;
    bookings.push({
      kind: "replacement",
      bookingId: r.id,
      lessonId: target.id,
      ...times(target, tz),
      groupName: target.group.name,
      oneOnOne: false,
      teacherName: target.teacher.user.name,
      startsAt: target.startsAt.toISOString(),
      originalDate: local(r.originalLesson.startsAt),
      cutoffAt: new Date(target.startsAt.getTime() - cutoffMs).toISOString(),
      credit: {
        sourceDate: local(r.makeupCredit.sourceLesson.startsAt),
        validUntil: validUntilOf(r.makeupCredit.expiresAt, tz),
        expired: now.getTime() >= r.makeupCredit.expiresAt.getTime(),
      },
      changedBySchool: r.status === "OVERRIDDEN" ? (r.reviewNote ?? "") : null,
      creditValidUntil: validUntilOf(r.makeupCredit.expiresAt, tz),
    });
  }
  // Released because the school cancelled the lesson (absences.md §11).
  const released = await db.replacementRequest.findMany({
    where: {
      studentId: student.id,
      status: "CANCELLED",
      cancelReason: "LESSON_CANCELLED",
    },
    select: {
      id: true,
      targetLesson: {
        select: { startsAt: true, group: { select: { name: true } } },
      },
    },
  });
  for (const r of released) {
    history.push({
      item: {
        kind: "removedBySchool",
        id: r.id,
        sourceDate: local(r.targetLesson.startsAt),
        groupName: r.targetLesson.group.name,
        reason: null,
        lessonCancelled: true,
      },
      sortAt: r.targetLesson.startsAt.getTime(),
    });
  }
  // Only while they are the group's student, like their timetable: a
  // 1-on-1 group can pass to another student (CARM-43 review).
  const memberships = await db.groupMembership.findMany({
    where: { studentId: student.id },
    select: { groupId: true, joinedAt: true, leftAt: true },
  });
  for (const lesson of rescheduled) {
    if (!isMemberAt(memberships, lesson.groupId, lesson.startsAt)) continue;
    const credit =
      lesson.spentCredit?.studentId === student.id ? lesson.spentCredit : null;
    const root = await rescheduleRoot(db, lesson);
    bookings.push({
      kind: "rescheduled",
      bookingId: null,
      lessonId: lesson.id,
      ...times(lesson, tz),
      groupName: lesson.group.name,
      oneOnOne: true,
      teacherName: lesson.teacher.user.name,
      startsAt: lesson.startsAt.toISOString(),
      originalDate: local(root.startsAt),
      cutoffAt: new Date(lesson.startsAt.getTime() - cutoffMs).toISOString(),
      credit: credit && {
        sourceDate: local(credit.sourceLesson.startsAt),
        validUntil: validUntilOf(credit.expiresAt, tz),
        expired: now.getTime() >= credit.expiresAt.getTime(),
      },
      changedBySchool: null,
      creditValidUntil: credit
        ? validUntilOf(credit.expiresAt, tz)
        : creditExpiry(root.startsAt, settings.makeupCreditValidDays, tz)
            .validUntil,
    });
  }
  bookings.sort(
    (a, b) =>
      a.startsAt.localeCompare(b.startsAt) ||
      a.lessonId.localeCompare(b.lessonId),
  );

  const available: StudentCredit[] = [];
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
      const usedOn =
        state === "USED"
          ? (credit.replacements[0]?.targetLesson ?? credit.rescheduledLesson)
          : null;
      history.push({
        item: {
          kind: state === "USED" ? "creditUsed" : "creditExpired",
          id: credit.id,
          sourceDate,
          groupName: source.group.name,
          expiredOn: toZonedDateTime(credit.expiresAt, tz).date,
          usedFor: usedOn
            ? {
                kind: credit.rescheduledLesson ? "rescheduled" : "replacement",
                groupName: usedOn.group.name,
                date: local(usedOn.startsAt),
                startMinute: toZonedDateTime(usedOn.startsAt, tz).minute,
              }
            : null,
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
      cutoffMinutes: settings.absenceCutoffMinutes,
    },
    credits: available,
    bookings,
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
    replacement: boolean;
  }[];
  seatsTaken: number;
  /** A 1-on-1 the student cancelled: who, and why. */
  oneOnOneCancelled: { name: string; reason: string | null } | null;
  /** A rescheduled 1-on-1: who moved it from when (absences.md §6.1). */
  rescheduledFrom: { name: string; startsAt: string; byAdmin: boolean } | null;
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
      rescheduledFrom: { select: { startsAt: true, cancelReason: true } },
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
        where: {
          OR: [
            { status: { in: [...ACTIVE_REPLACEMENT] } },
            { status: "CANCELLED", cancelReason: "STUDENT_LATE" },
          ],
        },
        select: {
          status: true,
          cancelledAt: true,
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
    replacements: lesson.replacementsTo
      .filter((r) => r.status !== "CANCELLED")
      .map((r) => ({
        id: r.student.id,
        name: r.student.user.name,
        fromGroup: r.originalLesson.group.name,
      })),
    lateCancelled: lesson.replacementsTo
      .filter((r) => r.status === "CANCELLED")
      .map((r) => ({
        id: r.student.id,
        name: r.student.user.name,
        cancelledAt: r.cancelledAt!,
      })),
  });
  const oneOnOne = lesson.group.type === "ONE_ON_ONE";
  // A 1-on-1 the student cancelled; one moved on with the same credit has
  // no report, so name the group's student.
  const studentCancelled =
    oneOnOne && lesson.cancelReason === STUDENT_CANCELLED
      ? (lesson.absenceReports[0] ?? {
          student: { user: { name: members[0]?.name ?? "" } },
          reason: null,
        })
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
    rescheduledFrom:
      oneOnOne && lesson.rescheduledFrom
        ? {
            name: members[0]?.name ?? "",
            startsAt: lesson.rescheduledFrom.startsAt.toISOString(),
            byAdmin: lesson.rescheduledFrom.cancelReason === RESCHEDULED,
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
    roomId: string | null;
  };
  student: { id: string; name: string };
  reportedAt: string;
  /** Name of the admin who reported it; null when the student did. */
  byAdmin: string | null;
  reason: string | null;
  credit: {
    id: string;
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
      makeupCredit: { select: { id: true, status: true, expiresAt: true } },
      lesson: {
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          roomId: true,
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
        roomId: row.lesson.roomId,
      },
      student: { id: row.student.id, name: row.student.user.name },
      reportedAt: row.createdAt.toISOString(),
      byAdmin:
        row.reportedById && row.reportedById !== row.student.userId
          ? (row.reportedBy?.name ?? null)
          : null,
      reason: row.reason,
      credit: row.makeupCredit && {
        id: row.makeupCredit.id,
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
