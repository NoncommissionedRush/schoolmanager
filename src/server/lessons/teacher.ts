// The teacher's lesson page, lesson list and dashboard To do card
// (docs/design/lessons.md §5). Authorization lives here, server-side: every
// query is limited to lessons the teacher teaches or substitutes
// (`teacherLessonWhere`) and runs on the school-scoped client. Internal
// notes are loaded separately through src/server/notes.

import { Prisma } from "@/generated/prisma/client";
import { AdminError, msg } from "@/server/admin/result";
import { loadLessonRoster } from "@/server/replacements/views";
import { addDays, toZonedDateTime, zonedTimeToUtc } from "@/server/scheduling";
import type { SchoolDb } from "@/server/timetable/service";

import { isUuid, teacherLessonWhere } from "./access";
import {
  isStale,
  type LessonFilter,
  lessonBadge,
  logLock,
  logWrite,
  matchesFilter,
  rosterCounts,
  type TeacherRelation,
  teacherRelation,
  TODO_DAYS,
  TODO_LIMIT,
} from "./rules";
import type { LessonLogInput } from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;

const logSelect = {
  content: true,
  homework: true,
  updatedAt: true,
  updatedBy: { select: { user: { select: { name: true } } } },
} satisfies Prisma.LessonLogSelect;

type LogRow = Prisma.LessonLogGetPayload<{ select: typeof logSelect }>;

/** The lesson log as the teacher's form shows it. */
export type LessonLogView = {
  content: string | null;
  homework: string | null;
  /** ISO; sent back on save for the conflict check. */
  updatedAt: string;
  updatedByName: string;
};

const toLogView = (row: LogRow | null): LessonLogView | null =>
  row && {
    content: row.content,
    homework: row.homework,
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: row.updatedBy.user.name,
  };

const pageSelect = {
  id: true,
  termId: true,
  timetableSlotId: true,
  groupId: true,
  teacherId: true,
  substituteTeacherId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  cancelReason: true,
  group: {
    select: {
      name: true,
      type: true,
      level: { select: { code: true } },
      memberships: {
        select: {
          joinedAt: true,
          leftAt: true,
          student: { select: { id: true, user: { select: { name: true } } } },
        },
      },
    },
  },
  teacher: { select: { user: { select: { name: true } } } },
  substituteTeacher: { select: { user: { select: { name: true } } } },
  room: { select: { name: true, kind: true, meetingUrl: true } },
  log: { select: logSelect },
} satisfies Prisma.LessonSelect;

/** A lesson page as teachers and admins see it (§5.2, §7). */
export type LessonPage = {
  id: string;
  termId: string;
  slotId: string | null;
  group: { id: string; name: string; type: "GROUP" | "ONE_ON_ONE" };
  level: string;
  /** Local date and times in the school's timezone. */
  date: string;
  startMinute: number;
  endMinute: number;
  startsAt: string;
  status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
  cancelReason: string | null;
  room: { name: string; online: boolean; meetingUrl: string | null } | null;
  teacherName: string;
  substituteName: string | null;
  badge: "cancelled" | "noLog" | null;
  /** Why the log can't be written now, or null when it can. */
  lock: "cancelled" | "notStarted" | null;
  log: LessonLogView | null;
  previousHomework: { homework: string; date: string } | null;
  previousLessonId: string | null;
  nextLessonId: string | null;
  /** Current members, for the note form's "About" picker. */
  students: { id: string; name: string }[];
};

export type TeacherLessonPage = LessonPage & { relation: TeacherRelation };

/**
 * Everything the teacher lesson page shows except the internal notes, or
 * null when the teacher may not open the lesson (→ 404).
 */
export async function loadTeacherLesson(
  db: SchoolDb,
  teacherId: string | null,
  lessonId: string,
  now: Date,
  timeZone: string,
): Promise<TeacherLessonPage | null> {
  if (!teacherId || !isUuid(lessonId)) return null;
  const found = await loadLessonPage(
    db,
    teacherLessonWhere(teacherId),
    lessonId,
    now,
    timeZone,
  );
  return (
    found && {
      ...found.page,
      relation: teacherRelation(found.lesson, teacherId),
    }
  );
}

/**
 * A lesson page among the lessons matching `mine` (the caller's access
 * rule, also used for previous/next), or null when there is none.
 */
export async function loadLessonPage(
  db: SchoolDb,
  mine: Prisma.LessonWhereInput,
  lessonId: string,
  now: Date,
  timeZone: string,
): Promise<{
  page: LessonPage;
  /** Who teaches it, for the caller's own rules. */
  lesson: { teacherId: string; substituteTeacherId: string | null };
} | null> {
  if (!isUuid(lessonId)) return null;
  const lesson = await db.lesson.findFirst({
    where: { AND: [{ id: lessonId }, mine] },
    select: pageSelect,
  });
  if (!lesson) return null;

  const ofGroup = { groupId: lesson.groupId };
  const order = (dir: Prisma.SortOrder) => [{ startsAt: dir }, { id: dir }];
  const before = {
    OR: [
      { startsAt: { lt: lesson.startsAt } },
      { startsAt: lesson.startsAt, id: { lt: lesson.id } },
    ],
  };
  const after = {
    OR: [
      { startsAt: { gt: lesson.startsAt } },
      { startsAt: lesson.startsAt, id: { gt: lesson.id } },
    ],
  };
  const [previous, next, previousOfGroup] = await Promise.all([
    db.lesson.findFirst({
      where: { AND: [ofGroup, mine, before] },
      orderBy: order("desc"),
      select: { id: true },
    }),
    db.lesson.findFirst({
      where: { AND: [ofGroup, mine, after] },
      orderBy: order("asc"),
      select: { id: true },
    }),
    // The group's previous lesson, whoever taught it: its homework is what
    // students were asked to prepare for this one.
    db.lesson.findFirst({
      where: { AND: [ofGroup, before, { status: { not: "CANCELLED" } }] },
      orderBy: order("desc"),
      select: { startsAt: true, log: { select: { homework: true } } },
    }),
  ]);

  const start = toZonedDateTime(lesson.startsAt, timeZone);
  const end = toZonedDateTime(lesson.endsAt, timeZone);
  const current = lesson.group.memberships.filter(
    (m) => m.leftAt === null || m.leftAt > now,
  );
  const page: LessonPage = {
    id: lesson.id,
    termId: lesson.termId,
    slotId: lesson.timetableSlotId,
    group: {
      id: lesson.groupId,
      name: lesson.group.name,
      type: lesson.group.type,
    },
    level: lesson.group.level.code,
    date: start.date,
    startMinute: start.minute,
    endMinute: end.date === start.date ? end.minute : 24 * 60,
    startsAt: lesson.startsAt.toISOString(),
    status: lesson.status,
    cancelReason: lesson.cancelReason,
    room: lesson.room && {
      name: lesson.room.name,
      online: lesson.room.kind === "ONLINE",
      meetingUrl: lesson.room.meetingUrl,
    },
    teacherName: lesson.teacher.user.name,
    substituteName: lesson.substituteTeacher?.user.name ?? null,
    badge: lessonBadge(lesson, lesson.log, now),
    lock: logLock(lesson, now),
    log: toLogView(lesson.log),
    previousHomework: previousOfGroup?.log?.homework
      ? {
          homework: previousOfGroup.log.homework,
          date: toZonedDateTime(previousOfGroup.startsAt, timeZone).date,
        }
      : null,
    previousLessonId: previous?.id ?? null,
    nextLessonId: next?.id ?? null,
    students: current
      .map((m) => ({ id: m.student.id, name: m.student.user.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  return {
    page,
    lesson: {
      teacherId: lesson.teacherId,
      substituteTeacherId: lesson.substituteTeacherId,
    },
  };
}

export type SaveLogResult =
  | { status: "saved"; log: LessonLogView | null }
  /** Someone else saved first; `by` is the name on the newer record. */
  | { status: "conflict"; by: string | null };

/**
 * Saves the lesson log form (§5.2): creates, updates or — with both fields
 * empty — removes the record. Refused with "not found" for lessons the
 * teacher can't open, with an error before the lesson starts or on a
 * cancelled lesson, and with a conflict when the record changed since the
 * form was loaded (`expectedUpdatedAt`).
 */
export async function saveLessonLog(
  db: SchoolDb,
  schoolId: string,
  teacherId: string | null,
  input: LessonLogInput,
  now: Date,
): Promise<SaveLogResult> {
  if (!teacherId) throw new AdminError(msg("common.error.notFound"));
  const lesson = await db.lesson.findFirst({
    where: { AND: [{ id: input.lessonId }, teacherLessonWhere(teacherId)] },
    select: { id: true, startsAt: true, endsAt: true, status: true },
  });
  if (!lesson) throw new AdminError(msg("common.error.notFound"));
  const lock = logLock(lesson, now);
  if (lock) throw new AdminError(msg(`lessonLog.locked.${lock}`));

  const conflict = async (): Promise<SaveLogResult> => {
    const latest = await db.lessonLog.findFirst({
      where: { lessonId: lesson.id },
      select: logSelect,
    });
    return { status: "conflict", by: latest?.updatedBy.user.name ?? null };
  };

  const current = await db.lessonLog.findFirst({
    where: { lessonId: lesson.id },
    select: { id: true, updatedAt: true },
  });
  if (isStale(input.expectedUpdatedAt, current)) return conflict();

  const texts = { content: input.content, homework: input.homework };
  // Writes are conditional on the `updatedAt` that was checked, so a save
  // that lands in between still counts as a conflict.
  const unchanged = { lessonId: lesson.id, updatedAt: current?.updatedAt };
  switch (logWrite(texts, current !== null)) {
    case "none":
      return { status: "saved", log: null };
    case "delete": {
      const { count } = await db.lessonLog.deleteMany({ where: unchanged });
      return count === 0 ? conflict() : { status: "saved", log: null };
    }
    case "update": {
      const { count } = await db.lessonLog.updateMany({
        where: unchanged,
        data: { ...texts, updatedById: teacherId },
      });
      if (count === 0) return conflict();
      break;
    }
    case "create":
      try {
        await db.lessonLog.create({
          data: {
            schoolId,
            lessonId: lesson.id,
            authorId: teacherId,
            updatedById: teacherId,
            ...texts,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          return conflict();
        }
        throw error;
      }
      break;
  }
  const saved = await db.lessonLog.findFirst({
    where: { lessonId: lesson.id },
    select: logSelect,
  });
  return { status: "saved", log: toLogView(saved) };
}

// ---------------------------------------------------------------------------
// Lesson list (§5.4) and To do card (§5.1)
// ---------------------------------------------------------------------------

const listSelect = {
  id: true,
  startsAt: true,
  endsAt: true,
  status: true,
  group: { select: { id: true, name: true, type: true } },
  teacher: { select: { user: { select: { name: true } } } },
  substituteTeacher: { select: { user: { select: { name: true } } } },
  log: { select: { content: true, homework: true } },
} satisfies Prisma.LessonSelect;

type ListRow = Prisma.LessonGetPayload<{ select: typeof listSelect }>;

export type LessonListItem = {
  id: string;
  date: string;
  startMinute: number;
  endMinute: number;
  group: { id: string; name: string; type: "GROUP" | "ONE_ON_ONE" };
  status: ListRow["status"];
  content: string | null;
  homework: string | null;
  badge: "cancelled" | "noLog" | null;
  teacherName: string;
  substituteName: string | null;
};

function toListItem(row: ListRow, now: Date, tz: string): LessonListItem {
  const start = toZonedDateTime(row.startsAt, tz);
  const end = toZonedDateTime(row.endsAt, tz);
  return {
    id: row.id,
    date: start.date,
    startMinute: start.minute,
    endMinute: end.date === start.date ? end.minute : 24 * 60,
    group: row.group,
    status: row.status,
    content: row.log?.content ?? null,
    homework: row.log?.homework ?? null,
    badge: lessonBadge(row, row.log, now),
    teacherName: row.teacher.user.name,
    substituteName: row.substituteTeacher?.user.name ?? null,
  };
}

/** Prisma filter matching `matchesFilter` (rules.ts), for the query. */
function filterWhere(filter: LessonFilter, now: Date): Prisma.LessonWhereInput {
  switch (filter) {
    case "noLog":
      return {
        endsAt: { lte: now },
        status: { not: "CANCELLED" },
        OR: [{ log: { is: null } }, { log: { is: { content: null } } }],
      };
    case "upcoming":
      return { startsAt: { gt: now } };
    case "past":
      return { startsAt: { lte: now } };
  }
}

export type LessonList = {
  items: LessonListItem[];
  noLogCount: number;
  terms: { id: string; name: string }[];
  termId: string | null;
  groups: { id: string; name: string }[];
  /** Teachers of the term's lessons (admin filter); empty for teachers. */
  teachers: { id: string; name: string }[];
};

export type ListOptions = {
  filter: LessonFilter;
  termId?: string;
  groupId?: string;
  /** Admin filter: lessons this teacher teaches or substitutes. */
  teacherId?: string;
  /** Load the teacher filter's options (admin list). */
  withTeachers?: boolean;
};

/** Lists can't grow without bound; a term has far fewer lessons per teacher. */
const LIST_LIMIT = 300;

/**
 * The teacher's lessons in one term (default: the current one) for a
 * filter, optionally of one group. "No log yet" and "Upcoming" run oldest
 * first, "Past" newest first.
 */
export async function listTeacherLessons(
  db: SchoolDb,
  teacherId: string | null,
  options: Omit<ListOptions, "teacherId" | "withTeachers">,
  now: Date,
  timeZone: string,
): Promise<LessonList> {
  return listLessons(
    db,
    teacherId ? teacherLessonWhere(teacherId) : null,
    options,
    now,
    timeZone,
  );
}

/**
 * Lessons matching `access` (null: none) in one published term, for a list
 * filter (§5.4, §7). Admins pass `{}` for the whole school and may filter
 * by teacher.
 */
export async function listLessons(
  db: SchoolDb,
  access: Prisma.LessonWhereInput | null,
  options: ListOptions,
  now: Date,
  timeZone: string,
): Promise<LessonList> {
  const terms = await db.term.findMany({
    where: { timetablePublishedAt: { not: null } },
    select: { id: true, name: true, startDate: true, endDate: true },
    orderBy: { startDate: "desc" },
  });
  const empty = {
    items: [],
    noLogCount: 0,
    terms: terms.map(({ id, name }) => ({ id, name })),
    termId: null,
    groups: [],
    teachers: [],
  };
  if (!access) return empty;
  const today = toZonedDateTime(now, timeZone).date;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const term =
    terms.find((t) => t.id === options.termId) ??
    terms.find((t) => iso(t.startDate) <= today && today <= iso(t.endDate)) ??
    terms.find((t) => iso(t.startDate) <= today) ??
    terms.at(-1);
  if (!term) return empty;

  const scope: Prisma.LessonWhereInput = {
    AND: [access, { termId: term.id }],
  };
  const withTeachers = options.withTeachers === true;
  const [groupRows, teacherRows] = await Promise.all([
    db.lesson.findMany({
      where: scope,
      distinct: ["groupId"],
      select: { group: { select: { id: true, name: true } } },
    }),
    withTeachers
      ? db.teacherProfile.findMany({
          where: {
            OR: [
              { lessons: { some: scope } },
              { substituteLessons: { some: scope } },
            ],
          },
          select: { id: true, user: { select: { name: true } } },
        })
      : [],
  ]);
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name);
  const groups = groupRows.map((r) => r.group).sort(byName);
  const teachers = teacherRows
    .map((r) => ({ id: r.id, name: r.user.name }))
    .sort(byName);
  const groupId = groups.some((g) => g.id === options.groupId)
    ? options.groupId
    : undefined;
  const teacherId = teachers.some((t) => t.id === options.teacherId)
    ? options.teacherId
    : undefined;
  const scoped: Prisma.LessonWhereInput = {
    AND: [
      scope,
      ...(groupId ? [{ groupId }] : []),
      ...(teacherId
        ? [{ OR: [{ teacherId }, { substituteTeacherId: teacherId }] }]
        : []),
    ],
  };
  const direction = options.filter === "past" ? "desc" : "asc";
  const [rows, noLogCount] = await Promise.all([
    db.lesson.findMany({
      where: { AND: [scoped, filterWhere(options.filter, now)] },
      select: listSelect,
      orderBy: [{ startsAt: direction }, { id: direction }],
      take: LIST_LIMIT,
    }),
    db.lesson.count({ where: { AND: [scoped, filterWhere("noLog", now)] } }),
  ]);
  return {
    // Belt and braces: the query already applies the filter.
    items: rows
      .filter((r) => matchesFilter(options.filter, r, r.log, now))
      .map((r) => toListItem(r, now, timeZone)),
    noLogCount,
    terms: terms.map(({ id, name }) => ({ id, name })),
    termId: term.id,
    groups,
    teachers,
  };
}

/** Up to 5 lessons of the last 14 days without a log, oldest first (§5.1). */
export async function loadTeacherTodo(
  db: SchoolDb,
  teacherId: string | null,
  now: Date,
  timeZone: string,
): Promise<LessonListItem[]> {
  if (!teacherId) return [];
  const rows = await db.lesson.findMany({
    where: {
      AND: [
        teacherLessonWhere(teacherId),
        filterWhere("noLog", now),
        { startsAt: { gte: new Date(now.getTime() - TODO_DAYS * DAY_MS) } },
      ],
    },
    select: listSelect,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: TODO_LIMIT,
  });
  return rows.map((r) => toListItem(r, now, timeZone));
}

/** One lesson of the teacher dashboard's Today list (app-layout.md §7.3). */
export type TodayLesson = {
  id: string;
  startMinute: number;
  endMinute: number;
  groupName: string;
  roomName: string | null;
  cancelled: boolean;
  /** "−{n} · +{r}" (absences.md §6.3); zero on cancelled lessons. */
  notComing: number;
  replacements: number;
};

/**
 * The teacher's lessons today (taught or substituted, published terms), in
 * the school's time zone, by start, each with the Students card's counts.
 */
export async function loadTeacherToday(
  db: SchoolDb,
  teacherId: string | null,
  now: Date,
  timeZone: string,
): Promise<TodayLesson[]> {
  if (!teacherId) return [];
  const today = toZonedDateTime(now, timeZone).date;
  const rows = await db.lesson.findMany({
    where: {
      AND: [
        teacherLessonWhere(teacherId),
        {
          startsAt: {
            gte: zonedTimeToUtc(today, 0, timeZone),
            lt: zonedTimeToUtc(addDays(today, 1), 0, timeZone),
          },
        },
      ],
    },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      group: { select: { name: true } },
      room: { select: { name: true } },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
  // A teacher has a handful of lessons a day: one roster query each keeps
  // the counts identical to the lesson page's Students card.
  const rosters = await Promise.all(
    rows.map((row) =>
      row.status === "CANCELLED" ? null : loadLessonRoster(db, row.id, now),
    ),
  );
  return rows.map((row, i) => {
    const start = toZonedDateTime(row.startsAt, timeZone);
    const end = toZonedDateTime(row.endsAt, timeZone);
    const roster = rosters[i];
    return {
      id: row.id,
      startMinute: start.minute,
      endMinute: end.date === start.date ? end.minute : 24 * 60,
      groupName: row.group.name,
      roomName: row.room?.name ?? null,
      cancelled: row.status === "CANCELLED",
      ...(roster ? rosterCounts(roster) : { notComing: 0, replacements: 0 }),
    };
  });
}

/** Whether the teacher has any lesson they can open (dashboard empty state). */
export async function teacherHasLessons(
  db: SchoolDb,
  teacherId: string | null,
): Promise<boolean> {
  if (!teacherId) return false;
  const lesson = await db.lesson.findFirst({
    where: teacherLessonWhere(teacherId),
    select: { id: true },
  });
  return lesson !== null;
}
