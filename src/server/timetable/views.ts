// Read-only weekly timetable data for admin, teacher and student
// (docs/design/timetable.md §2, §6). Authorization lives here, server-side:
// teachers get only lessons they teach or substitute, students only lessons
// of groups they belong to on that date, and neither sees unpublished terms.
// Callers pass the school-scoped client and the signed-in viewer.

import type { Prisma } from "@/generated/prisma/client";
import {
  addDays,
  fromIsoDate,
  holidaysOfTerm,
  type IsoDate,
  isoWeekday,
  toIsoDate,
  toZonedDateTime,
  zonedTimeToUtc,
} from "@/server/scheduling";

import { ACTIVE_REPLACEMENT } from "@/server/replacements/release";
import { loadStudentAttendance } from "@/server/replacements/views";

import type { SchoolDb } from "./service";
import {
  gridHours,
  gridWeekdays,
  isMemberAt,
  type LessonRecord,
  type LessonView,
  membersAt,
  type MembershipWindow,
  toLessonView,
  type ViewerKind,
} from "./week";

export type WeekViewer = { kind: ViewerKind; userId: string };

export type WeekFilters = {
  teacherId?: string;
  roomId?: string;
  groupId?: string;
};

export type WeekState =
  | "ok"
  /** No term overlaps the week. */
  | "noTerm"
  /** Terms overlap the week but none is published (teacher/student). */
  | "notPublished"
  /** Student who is in no group at all. */
  | "noGroups";

export type WeekData = {
  week: IsoDate;
  days: { date: IsoDate; weekday: number; holiday: string | null }[];
  hours: { startMinute: number; endMinute: number };
  lessons: LessonView[];
  state: WeekState;
  /** First day of the next term, when the week has no term. */
  nextTermStart: IsoDate | null;
  /** The next lesson after this week (empty-state link). */
  nextLesson: { date: IsoDate; startsAt: string } | null;
  /** Term shown this week, for the admin's "Edit timetable" link. */
  termId: string | null;
};

const groupSelect = {
  id: true,
  name: true,
  type: true,
  level: { select: { code: true } },
} satisfies Prisma.GroupSelect;

// Students never load group memberships, so classmates' names are not even
// read from the database for them.
const studentLessonSelect = {
  id: true,
  termId: true,
  timetableSlotId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  cancelReason: true,
  group: { select: groupSelect },
  teacher: { select: { id: true, user: { select: { name: true } } } },
  substituteTeacher: {
    select: { id: true, user: { select: { name: true } } },
  },
  room: { select: { id: true, name: true, kind: true, meetingUrl: true } },
} satisfies Prisma.LessonSelect;

// Students also get the homework of lessons that have started (lessons.md
// §5.1); never "What we covered" or anything else of the log.
const studentWeekSelect = {
  ...studentLessonSelect,
  log: { select: { homework: true } },
} satisfies Prisma.LessonSelect;

const staffLessonSelect = {
  ...studentLessonSelect,
  group: {
    select: {
      ...groupSelect,
      memberships: {
        select: {
          joinedAt: true,
          leftAt: true,
          student: { select: { id: true, user: { select: { name: true } } } },
        },
      },
    },
  },
} satisfies Prisma.LessonSelect;

type StudentLessonRow = Prisma.LessonGetPayload<{
  select: typeof studentWeekSelect;
}>;
type StaffLessonRow = Prisma.LessonGetPayload<{
  select: typeof staffLessonSelect;
}>;

function toRecord(
  row: StudentLessonRow | StaffLessonRow,
  now: Date,
): LessonRecord {
  return {
    id: row.id,
    termId: row.termId,
    timetableSlotId: row.timetableSlotId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status,
    cancelReason: row.cancelReason,
    group: {
      id: row.group.id,
      name: row.group.name,
      type: row.group.type,
      level: row.group.level,
    },
    teacher: { id: row.teacher.id, name: row.teacher.user.name },
    substitute: row.substituteTeacher
      ? {
          id: row.substituteTeacher.id,
          name: row.substituteTeacher.user.name,
        }
      : null,
    room: row.room,
    // Students' names are loaded only for admins and teachers.
    students:
      "memberships" in row.group
        ? membersAt(row.group.memberships, row.startsAt).map((m) => ({
            id: m.student.id,
            name: m.student.user.name,
          }))
        : [],
    homework:
      "log" in row && row.startsAt <= now ? (row.log?.homework ?? null) : null,
  };
}

/**
 * Lessons a student may see: those of their groups that start while they
 * are a member (joined on or before, left after). Matches `isMemberAt`, but
 * in the query, so limits and ordering apply to visible lessons only.
 */
export function membershipLessonWhere(
  memberships: readonly MembershipWindow[],
): Prisma.LessonWhereInput {
  if (memberships.length === 0) return { id: { in: [] } };
  return {
    OR: memberships.map((m) => ({
      groupId: m.groupId,
      startsAt: {
        gte: m.joinedAt,
        ...(m.leftAt && { lt: m.leftAt }),
      },
    })),
  };
}

/** Lessons of one week (Monday `week`) as `viewer` may see them. */
export async function loadWeek(
  db: SchoolDb,
  viewer: WeekViewer,
  week: IsoDate,
  filters: WeekFilters = {},
): Promise<WeekData> {
  const school = await db.school.findFirstOrThrow({
    select: {
      timezone: true,
      teachingWeekdays: true,
      dayStartMinute: true,
      dayEndMinute: true,
    },
  });
  const tz = school.timezone;
  const weekEnd = addDays(week, 6);
  const from = zonedTimeToUtc(week, 0, tz);
  const until = zonedTimeToUtc(addDays(week, 7), 0, tz);

  const terms = await db.term.findMany({
    where: {
      startDate: { lte: fromIsoDate(weekEnd) },
      endDate: { gte: fromIsoDate(week) },
    },
    select: { id: true, startDate: true, timetablePublishedAt: true },
    orderBy: { startDate: "asc" },
  });
  const visibleTerms =
    viewer.kind === "ADMIN"
      ? terms
      : terms.filter((t) => t.timetablePublishedAt !== null);

  // Who is asking decides which lessons exist for them at all.
  let where: Prisma.LessonWhereInput;
  let teacherId: string | undefined;
  let memberships: MembershipWindow[] = [];
  let booked: string[] = [];
  let student: { id: string; userId: string } | null = null;
  if (viewer.kind === "TEACHER") {
    const profile = await db.teacherProfile.findFirst({
      where: { userId: viewer.userId },
      select: { id: true },
    });
    teacherId = profile?.id ?? "00000000-0000-0000-0000-000000000000";
    where = {
      OR: [{ teacherId }, { substituteTeacherId: teacherId }],
      term: { timetablePublishedAt: { not: null } },
    };
  } else if (viewer.kind === "STUDENT") {
    const profile = await db.studentProfile.findFirst({
      where: { userId: viewer.userId },
      select: {
        id: true,
        userId: true,
        groupMemberships: {
          select: { groupId: true, joinedAt: true, leftAt: true },
        },
        // Lessons they joined as a replacement (absences.md §5.8).
        replacementRequests: {
          where: { status: { in: [...ACTIVE_REPLACEMENT] } },
          select: { targetLessonId: true },
        },
      },
    });
    memberships = profile?.groupMemberships ?? [];
    booked = (profile?.replacementRequests ?? []).map((r) => r.targetLessonId);
    student = profile && { id: profile.id, userId: profile.userId };
    where = {
      AND: [
        booked.length > 0
          ? {
              OR: [membershipLessonWhere(memberships), { id: { in: booked } }],
            }
          : membershipLessonWhere(memberships),
        { term: { timetablePublishedAt: { not: null } } },
      ],
    };
  } else {
    where = {
      ...(filters.teacherId && {
        OR: [
          { teacherId: filters.teacherId },
          { substituteTeacherId: filters.teacherId },
        ],
      }),
      ...(filters.roomId && { roomId: filters.roomId }),
      ...(filters.groupId && { groupId: filters.groupId }),
    };
  }

  const inWeek = { startsAt: { gte: from, lt: until } };
  const query = {
    where: { AND: [where, inWeek] },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  } satisfies Prisma.LessonFindManyArgs;
  const rows =
    viewer.kind === "STUDENT"
      ? await db.lesson.findMany({ ...query, select: studentWeekSelect })
      : await db.lesson.findMany({ ...query, select: staffLessonSelect });
  // Belt and braces: the query already applies the membership windows.
  const allowed =
    viewer.kind === "STUDENT"
      ? rows.filter(
          (r) =>
            isMemberAt(memberships, r.group.id, r.startsAt) ||
            booked.includes(r.id),
        )
      : rows;
  const now = new Date();
  // Students also get their own cancellation of each lesson (absences.md §5.1).
  const attendance = student
    ? await loadStudentAttendance(db, student, allowed, now)
    : new Map();
  const lessons = allowed.map((row) => ({
    ...toLessonView(toRecord(row, now), { kind: viewer.kind, teacherId }, tz),
    attendance: attendance.get(row.id) ?? null,
  }));

  // Holidays of the terms this week (school-wide ones count everywhere).
  const holidays = await db.holiday.findMany({
    where: {
      startDate: { lte: fromIsoDate(weekEnd) },
      endDate: { gte: fromIsoDate(week) },
    },
    select: {
      id: true,
      name: true,
      termId: true,
      startDate: true,
      endDate: true,
    },
  });
  const holidayRanges = holidays.map((h) => ({
    id: h.id,
    name: h.name,
    termId: h.termId,
    startDate: toIsoDate(h.startDate),
    endDate: toIsoDate(h.endDate),
  }));
  const applicable = new Map<string, (typeof holidayRanges)[number]>();
  for (const term of visibleTerms) {
    for (const h of holidaysOfTerm(holidayRanges, term.id)) {
      applicable.set(h.id, h);
    }
  }
  const holidayOn = (date: IsoDate) =>
    [...applicable.values()].find(
      (h) => h.startDate <= date && date <= h.endDate,
    )?.name ?? null;

  const weekdays = gridWeekdays(
    school.teachingWeekdays,
    lessons.map((l) => isoWeekday(l.date)),
  );
  const days = weekdays.map((weekday) => {
    const date = addDays(week, weekday - 1);
    return { date, weekday, holiday: holidayOn(date) };
  });

  let state: WeekState = "ok";
  if (viewer.kind === "STUDENT" && memberships.length === 0) state = "noGroups";
  else if (terms.length === 0) state = "noTerm";
  else if (visibleTerms.length === 0) state = "notPublished";

  let nextTermStart: IsoDate | null = null;
  if (state === "noTerm") {
    const next = await db.term.findFirst({
      where: { startDate: { gt: fromIsoDate(weekEnd) } },
      orderBy: { startDate: "asc" },
      select: { startDate: true },
    });
    nextTermStart = next ? toIsoDate(next.startDate) : null;
  }

  let nextLesson: WeekData["nextLesson"] = null;
  if (lessons.length === 0 && state !== "noGroups") {
    const next = await db.lesson.findFirst({
      where: {
        AND: [where, { startsAt: { gte: until }, status: "SCHEDULED" }],
      },
      select: { startsAt: true },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    });
    if (next) {
      nextLesson = {
        date: toZonedDateTime(next.startsAt, tz).date,
        startsAt: next.startsAt.toISOString(),
      };
    }
  }

  return {
    week,
    days,
    hours: gridHours(school, lessons),
    lessons,
    state,
    nextTermStart,
    nextLesson,
    termId:
      (visibleTerms.find((t) => t.timetablePublishedAt) ?? visibleTerms[0])
        ?.id ?? null,
  };
}

/** Filter options for the admin weekly view (archived ones included, listed last). */
export async function loadWeekFilterOptions(db: SchoolDb) {
  const [teachers, rooms, groups] = await Promise.all([
    db.teacherProfile.findMany({
      select: { id: true, user: { select: { name: true, deletedAt: true } } },
      orderBy: { user: { name: "asc" } },
    }),
    db.room.findMany({
      select: { id: true, name: true, archivedAt: true },
      orderBy: { name: "asc" },
    }),
    db.group.findMany({
      select: { id: true, name: true, deletedAt: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const option = (id: string, name: string, archived: boolean) => ({
    id,
    name,
    archived,
  });
  const sortArchivedLast = <T extends { archived: boolean }>(list: T[]) =>
    [...list].sort((a, b) => Number(a.archived) - Number(b.archived));
  return {
    teachers: sortArchivedLast(
      teachers.map((t) => option(t.id, t.user.name, t.user.deletedAt !== null)),
    ),
    rooms: sortArchivedLast(
      rooms.map((r) => option(r.id, r.name, r.archivedAt !== null)),
    ),
    groups: sortArchivedLast(
      groups.map((g) => option(g.id, g.name, g.deletedAt !== null)),
    ),
  };
}
