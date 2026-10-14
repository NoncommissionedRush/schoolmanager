// What students read of their lessons (docs/design/lessons.md §2, §6): the
// Homework tab, the lesson page and the home card. Authorization lives here,
// server-side: every query is limited by `studentLessonWhere` (groups the
// student was a member of when the lesson started, or lessons they're booked
// onto as a replacement; published terms; lessons that have started) and
// runs on the school-scoped client.
//
// Students get their own DTOs, built from selects that never touch
// TeacherNote. This module must not import src/server/notes
// (student.test.ts checks it).

import type { Prisma } from "@/generated/prisma/client";
import { toZonedDateTime } from "@/server/scheduling";
import type { SchoolDb } from "@/server/timetable/service";
import { membershipLessonWhere } from "@/server/timetable/views";
import type { MembershipWindow } from "@/server/timetable/week";

import { ACTIVE_REPLACEMENT } from "@/server/replacements/release";

import { isUuid } from "./access";
import { canStudentSeeLesson, pickLatestHomework } from "./student-rules";

/**
 * The signed-in student in this school: profile id, group memberships and
 * the lessons of their active replacement bookings (absences.md §2).
 */
export type StudentScope = {
  studentId: string | null;
  memberships: MembershipWindow[];
  bookedLessonIds: string[];
};

export async function loadStudentScope(
  db: SchoolDb,
  userId: string,
): Promise<StudentScope> {
  const profile = await db.studentProfile.findFirst({
    where: { userId },
    select: {
      id: true,
      groupMemberships: {
        select: { groupId: true, joinedAt: true, leftAt: true },
      },
      // Rejected, cancelled or moved bookings give no access.
      replacementRequests: {
        where: { status: { in: [...ACTIVE_REPLACEMENT] } },
        select: { targetLessonId: true },
      },
    },
  });
  return {
    studentId: profile?.id ?? null,
    memberships: profile?.groupMemberships ?? [],
    bookedLessonIds: (profile?.replacementRequests ?? []).map(
      (r) => r.targetLessonId,
    ),
  };
}

/**
 * Lessons a student may read (§2): of groups they were a member of when the
 * lesson started, or booked onto as a replacement, in a published term, and
 * already started.
 */
export function studentLessonWhere(
  memberships: readonly MembershipWindow[],
  now: Date,
  bookedLessonIds: readonly string[] = [],
): Prisma.LessonWhereInput {
  return {
    AND: [
      bookedLessonIds.length > 0
        ? {
            OR: [
              membershipLessonWhere(memberships),
              { id: { in: [...bookedLessonIds] } },
            ],
          }
        : membershipLessonWhere(memberships),
      { term: { timetablePublishedAt: { not: null } } },
      { startsAt: { lte: now } },
    ],
  };
}

// The only lesson fields a student response is built from. No TeacherNote,
// no group memberships (classmates), no log author.
const studentSelect = {
  id: true,
  groupId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  cancelReason: true,
  group: {
    select: { name: true, type: true, level: { select: { code: true } } },
  },
  teacher: { select: { user: { select: { name: true } } } },
  substituteTeacher: { select: { user: { select: { name: true } } } },
  room: { select: { name: true, kind: true, meetingUrl: true } },
  term: { select: { timetablePublishedAt: true } },
  log: { select: { content: true, homework: true } },
} satisfies Prisma.LessonSelect;

type StudentRow = Prisma.LessonGetPayload<{ select: typeof studentSelect }>;

/**
 * A lesson as a student sees it: the student-safe DTO (§2). It has no field
 * for internal notes or other students, by construction.
 */
export type StudentLessonView = {
  id: string;
  group: { id: string; name: string; type: "GROUP" | "ONE_ON_ONE" };
  level: string;
  /** Local date and times in the school's timezone. */
  date: string;
  startMinute: number;
  endMinute: number;
  status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
  cancelReason: string | null;
  teacherName: string;
  substituteName: string | null;
  room: { name: string; online: boolean; meetingUrl: string | null } | null;
  /** "What we covered". */
  content: string | null;
  homework: string | null;
};

/** Keys of `StudentLessonView`, for tests that pin the DTO's shape. */
export const STUDENT_LESSON_KEYS = [
  "id",
  "group",
  "level",
  "date",
  "startMinute",
  "endMinute",
  "status",
  "cancelReason",
  "teacherName",
  "substituteName",
  "room",
  "content",
  "homework",
] as const satisfies readonly (keyof StudentLessonView)[];

function toStudentView(row: StudentRow, timeZone: string): StudentLessonView {
  const start = toZonedDateTime(row.startsAt, timeZone);
  const end = toZonedDateTime(row.endsAt, timeZone);
  return {
    id: row.id,
    group: { id: row.groupId, name: row.group.name, type: row.group.type },
    level: row.group.level.code,
    date: start.date,
    startMinute: start.minute,
    endMinute: end.date === start.date ? end.minute : 24 * 60,
    status: row.status,
    cancelReason: row.cancelReason,
    teacherName: row.teacher.user.name,
    substituteName: row.substituteTeacher?.user.name ?? null,
    room: row.room && {
      name: row.room.name,
      online: row.room.kind === "ONLINE",
      meetingUrl: row.room.meetingUrl,
    },
    content: row.log?.content ?? null,
    homework: row.log?.homework ?? null,
  };
}

/** Belt and braces: the query already applies the same rule. */
const visible = (scope: StudentScope, row: StudentRow, now: Date) =>
  canStudentSeeLesson(
    scope.memberships,
    {
      id: row.id,
      groupId: row.groupId,
      startsAt: row.startsAt,
      published: row.term.timetablePublishedAt !== null,
    },
    now,
    scope.bookedLessonIds,
  );

/**
 * The student lesson page (§6.4), or null when the student may not read
 * the lesson (→ 404, also for malformed ids).
 */
export async function loadStudentLesson(
  db: SchoolDb,
  scope: StudentScope,
  lessonId: string,
  now: Date,
  timeZone: string,
): Promise<StudentLessonView | null> {
  if (!scope.studentId || !isUuid(lessonId)) return null;
  const row = await db.lesson.findFirst({
    where: {
      AND: [
        { id: lessonId },
        studentLessonWhere(scope.memberships, now, scope.bookedLessonIds),
      ],
    },
    select: studentSelect,
  });
  if (!row || !visible(scope, row, now)) return null;
  return toStudentView(row, timeZone);
}

export type StudentHomework = {
  items: StudentLessonView[];
  /** More lessons exist beyond `items` ("Load more"). */
  hasMore: boolean;
  /** Every group the student has been in, for the filter (§6.2). */
  groups: { id: string; name: string }[];
  /** The selected group, if the filter is set to a valid one. */
  groupId: string | null;
};

/**
 * The Homework tab (§6.2): the student's lessons that have started, newest
 * first, across all their groups (including ones they left), optionally of
 * one group. Returns the first `shown`.
 */
export async function listStudentHomework(
  db: SchoolDb,
  scope: StudentScope,
  options: { groupId?: string; shown: number },
  now: Date,
  timeZone: string,
): Promise<StudentHomework> {
  if (!scope.studentId || scope.memberships.length === 0) {
    return { items: [], hasMore: false, groups: [], groupId: null };
  }
  const groupIds = [...new Set(scope.memberships.map((m) => m.groupId))];
  const groupRows = await db.group.findMany({
    where: { id: { in: groupIds } },
    select: { id: true, name: true },
  });
  const groups = groupRows.sort((a, b) => a.name.localeCompare(b.name));
  const groupId = groups.some((g) => g.id === options.groupId)
    ? options.groupId!
    : null;
  const rows = await db.lesson.findMany({
    where: {
      AND: [
        studentLessonWhere(scope.memberships, now, scope.bookedLessonIds),
        ...(groupId ? [{ groupId }] : []),
      ],
    },
    select: studentSelect,
    orderBy: [{ startsAt: "desc" }, { id: "desc" }],
    take: options.shown + 1,
  });
  const allowed = rows.filter((row) => visible(scope, row, now));
  return {
    items: allowed
      .slice(0, options.shown)
      .map((row) => toStudentView(row, timeZone)),
    hasMore: rows.length > options.shown,
    groups,
    groupId,
  };
}

export type LatestHomework = {
  group: { id: string; name: string };
  date: string;
  homework: string;
  /** Link target; null when the lesson predates the student joining. */
  lessonId: string | null;
};

/**
 * The home card "Latest homework" (§6.3): the homework from the most recent
 * lesson of each group the student is in now, up to 3. A student who just
 * joined also sees the group's latest homework, so they know what to
 * prepare for their first lesson (§10, decision §12.3) — but that lesson
 * itself stays closed to them.
 */
export async function loadLatestHomework(
  db: SchoolDb,
  scope: StudentScope,
  now: Date,
  timeZone: string,
): Promise<LatestHomework[]> {
  if (!scope.studentId) return [];
  const current = scope.memberships.filter(
    (m) => m.joinedAt <= now && (m.leftAt === null || now < m.leftAt),
  );
  const groupIds = [...new Set(current.map((m) => m.groupId))];
  const latest = await Promise.all(
    groupIds.map((groupId) =>
      db.lesson.findFirst({
        where: {
          groupId,
          startsAt: { lte: now },
          status: { not: "CANCELLED" },
          term: { timetablePublishedAt: { not: null } },
        },
        orderBy: [{ startsAt: "desc" }, { id: "desc" }],
        // Only what the card shows: no "What we covered", no teacher.
        select: {
          id: true,
          groupId: true,
          startsAt: true,
          group: { select: { name: true } },
          log: { select: { homework: true } },
        },
      }),
    ),
  );
  return pickLatestHomework(
    latest.map((row) => row && { ...row, homework: row.log?.homework ?? null }),
  ).map((row) => ({
    group: { id: row.groupId, name: row.group.name },
    date: toZonedDateTime(row.startsAt, timeZone).date,
    homework: row.homework,
    lessonId: canStudentSeeLesson(
      scope.memberships,
      { groupId: row.groupId, startsAt: row.startsAt, published: true },
      now,
    )
      ? row.id
      : null,
  }));
}
