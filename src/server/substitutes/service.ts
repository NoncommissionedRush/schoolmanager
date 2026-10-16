// Substitute teachers: the database service (docs/architecture/
// phase5-rules.md §3). Loads plain data through the school-scoped client,
// asks the pure rules in src/server/scheduling/substitutes.ts, and writes
// one action per transaction under the school's timetable lock, with a
// conditional update so a lesson that changed meanwhile is never written
// (`changed`). Admin-only: callers check `requireRole("ADMIN")` first.

import type { Prisma } from "@/generated/prisma/client";
import { AdminError, msg } from "@/server/admin/result";
import { isUuid } from "@/server/lessons/access";
import {
  type LessonFacts,
  type NotificationDraft,
  type NotificationEvent,
  type PersonRef,
  recipientsFor,
} from "@/server/notifications/rules";
import { loadLessonFact, notify } from "@/server/notifications/service";
import {
  addDays,
  buildCalendar,
  type Calendar,
  checkSubstitute,
  checkSubstituteRemoval,
  isoWeekOf,
  type IsoDate,
  type LessonInfo,
  lessonPhase,
  lessonsNeedingCover,
  NEEDS_COVER_DAYS,
  type NeedsCover,
  SUBSTITUTE_RECORD_DAYS,
  substituteLessonReasons,
  type SubstituteLessonReasonCode,
  type SubstituteReason,
  type SubstituteSuggestion,
  type SubstituteTeacher,
  suggestSubstitutes,
  toIsoDate,
  toZonedDateTime,
  zonedTimeToUtc,
} from "@/server/scheduling";
import { lockTimetable } from "@/server/timetable/lock";
import {
  loadSchedulingContext,
  type SchoolDb,
  type Tx,
} from "@/server/timetable/service";

const DAY_MS = 86_400_000;

const notFound = () => new AdminError(msg("common.error.notFound"));

/** The lesson and everything the rules need, read inside `tx`. */
type Loaded = {
  timeZone: string;
  lesson: LessonInfo;
  published: boolean;
  calendar: Calendar;
  teachers: (SubstituteTeacher & { userId: string })[];
  history: { groupLessons: LessonInfo[] };
};

const lessonSelect = {
  id: true,
  termId: true,
  timetableSlotId: true,
  occurrenceDate: true,
  groupId: true,
  teacherId: true,
  substituteTeacherId: true,
  roomId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  term: { select: { startDate: true, timetablePublishedAt: true } },
} satisfies Prisma.LessonSelect;

type LessonRow = Prisma.LessonGetPayload<{ select: typeof lessonSelect }>;

const toInfo = (row: Omit<LessonRow, "term">): LessonInfo => ({
  id: row.id,
  termId: row.termId,
  timetableSlotId: row.timetableSlotId,
  occurrenceDate: row.occurrenceDate ? toIsoDate(row.occurrenceDate) : null,
  groupId: row.groupId,
  teacherId: row.teacherId,
  substituteTeacherId: row.substituteTeacherId,
  roomId: row.roomId,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  status: row.status,
});

/** Every teacher of the school, archived ones marked (§3.3 rule 3). */
async function loadTeachers(
  tx: Tx | SchoolDb,
): Promise<(SubstituteTeacher & { userId: string })[]> {
  const [profiles, memberships] = await Promise.all([
    tx.teacherProfile.findMany({
      select: {
        id: true,
        userId: true,
        maxMinutesPerWeek: true,
        user: { select: { name: true, deletedAt: true } },
      },
    }),
    tx.membership.findMany({
      where: { role: "TEACHER" },
      select: { userId: true },
    }),
  ]);
  const teaching = new Set(memberships.map((m) => m.userId));
  return profiles.map((p) => ({
    id: p.id,
    userId: p.userId,
    name: p.user.name,
    archived: p.user.deletedAt !== null || !teaching.has(p.userId),
    maxMinutesPerWeek: p.maxMinutesPerWeek,
  }));
}

/**
 * The lesson with the checker's context for its whole ISO week (teaching
 * minutes) and the group's lessons in its term and the previous one
 * (`knowsGroup`).
 */
async function load(tx: Tx, lessonId: string): Promise<Loaded> {
  if (!isUuid(lessonId)) throw notFound();
  const row = await tx.lesson.findFirst({
    where: { id: lessonId },
    select: lessonSelect,
  });
  if (!row) throw notFound();
  const school = await tx.school.findFirstOrThrow({
    select: { timezone: true },
  });
  const timeZone = school.timezone;
  const week = isoWeekOf(row.startsAt, timeZone);
  const from = toZonedDateTime(week.from, timeZone).date;
  const { context } = await loadSchedulingContext(tx, from, addDays(from, 6));
  const previous = await tx.term.findFirst({
    where: { endDate: { lt: row.term.startDate } },
    orderBy: { endDate: "desc" },
    select: { id: true },
  });
  const [teachers, groupLessons] = await Promise.all([
    loadTeachers(tx),
    tx.lesson.findMany({
      where: {
        groupId: row.groupId,
        termId: { in: [row.termId, ...(previous ? [previous.id] : [])] },
      },
      select: lessonSelect,
    }),
  ]);
  return {
    timeZone,
    lesson: toInfo(row),
    published: row.term.timetablePublishedAt !== null,
    calendar: buildCalendar(context),
    teachers,
    history: { groupLessons: groupLessons.map(toInfo) },
  };
}

// ---------------------------------------------------------------------------
// Notify preview (§3.5): the same `recipientsFor` the action uses
// ---------------------------------------------------------------------------

export type NotifyPreview = {
  teachers: { id: string; name: string; audience: string }[];
  studentCount: number;
};

function preview(
  events: NotificationEvent[],
  actorId: string,
  now: Date,
  timeZone: string,
  names: Map<string, string>,
): NotifyPreview {
  const drafts: NotificationDraft[] = events.flatMap((e) =>
    recipientsFor(e, { actorId, now, timeZone }),
  );
  const teachers = new Map<string, NotifyPreview["teachers"][number]>();
  const students = new Set<string>();
  for (const d of drafts) {
    if (d.audience === "student") students.add(d.recipientId);
    else if (!teachers.has(d.recipientId)) {
      teachers.set(d.recipientId, {
        id: d.recipientId,
        name: names.get(d.recipientId) ?? "",
        audience: d.audience,
      });
    }
  }
  return { teachers: [...teachers.values()], studentCount: students.size };
}

/** The events an assign (or change) to `next` emits. */
function assignEvents(
  facts: LessonFacts,
  next: PersonRef,
  previous: PersonRef | null,
): NotificationEvent[] {
  const after = { ...facts, substitute: next };
  return [
    ...(previous
      ? [
          {
            type: "SUBSTITUTE_REMOVED" as const,
            lesson: after,
            removed: previous,
            next,
          },
        ]
      : []),
    { type: "SUBSTITUTE_ASSIGNED", lesson: after, previous },
  ];
}

function removeEvents(
  facts: LessonFacts,
  removed: PersonRef,
): NotificationEvent[] {
  return [
    {
      type: "SUBSTITUTE_REMOVED",
      lesson: { ...facts, substitute: null },
      removed,
      next: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// The sheet (§3.7, design §5.3)
// ---------------------------------------------------------------------------

export type SubstituteCandidate = SubstituteSuggestion & {
  notify: NotifyPreview;
};

export type SubstituteSheet = {
  lesson: {
    id: string;
    groupName: string;
    groupType: "GROUP" | "ONE_ON_ONE";
    level: string | null;
    startsAt: string;
    endsAt: string;
    room: string | null;
    regular: { id: string; name: string };
    substitute: { id: string; name: string } | null;
    phase: "upcoming" | "started" | "ended";
  };
  /** Why the lesson needs cover, if it does. */
  needsCover: NeedsCover | null;
  /** §3.2 refusals: the actions are hidden when any applies. */
  lessonReasons: SubstituteLessonReasonCode[];
  candidates: SubstituteCandidate[];
  /** Removing the current substitute, if there is one. */
  remove: {
    refused: boolean;
    otherGroup: string | null;
    reasons: SubstituteReason[];
    notify: NotifyPreview;
  } | null;
  /** Sent back with the action: the lesson as the admin saw it. */
  expected: { substituteId: string | null; startsAt: string };
};

/** Everything the _Find a substitute_ sheet shows for one lesson. */
export async function loadSubstituteSheet(
  db: SchoolDb,
  actor: { userId: string },
  lessonId: string,
  now: Date,
): Promise<SubstituteSheet> {
  return db.$transaction(async (tx) => {
    const loaded = await load(tx, lessonId);
    const { lesson, calendar, teachers, timeZone } = loaded;
    const [details, facts] = await Promise.all([
      tx.lesson.findFirstOrThrow({
        where: { id: lesson.id },
        select: {
          group: {
            select: {
              name: true,
              type: true,
              level: { select: { name: true } },
            },
          },
          room: { select: { name: true } },
        },
      }),
      loadLessonFact(tx, lesson.id),
    ]);
    const byId = new Map(teachers.map((t) => [t.id, t]));
    const names = new Map(teachers.map((t) => [t.userId, t.name]));
    const person = (id: string): PersonRef => ({
      userId: byId.get(id)!.userId,
      name: byId.get(id)!.name,
    });
    const regular = byId.get(lesson.teacherId)!;
    const current = lesson.substituteTeacherId
      ? byId.get(lesson.substituteTeacherId)!
      : null;
    const suggestions = suggestSubstitutes(
      calendar,
      lesson,
      teachers,
      loaded.history,
      now,
    );
    const candidates = suggestions.map((s) => ({
      ...s,
      notify:
        facts && !s.current
          ? preview(
              assignEvents(
                facts,
                person(s.teacherId),
                current ? person(current.id) : null,
              ),
              actor.userId,
              now,
              timeZone,
              names,
            )
          : { teachers: [], studentCount: 0 },
    }));
    let remove: SubstituteSheet["remove"] = null;
    if (current && facts) {
      const check = checkSubstituteRemoval(calendar, lesson);
      remove = {
        refused: check.refused,
        otherGroup: check.otherGroup,
        reasons: check.reasons,
        notify: preview(
          removeEvents(facts, person(current.id)),
          actor.userId,
          now,
          timeZone,
          names,
        ),
      };
    }
    const archived = new Set(
      teachers.filter((t) => t.archived).map((t) => t.id),
    );
    const [needsCover] = lessonsNeedingCover(
      calendar,
      lesson.startsAt,
      new Date(lesson.startsAt.getTime() + 1),
      archived,
      // Why this lesson needs cover, whether or not it has started.
      new Date(lesson.startsAt.getTime() - 1),
    ).filter((n) => n.lessonId === lesson.id);
    return {
      lesson: {
        id: lesson.id,
        groupName: details.group.name,
        groupType: details.group.type,
        level: details.group.level?.name ?? null,
        startsAt: lesson.startsAt.toISOString(),
        endsAt: lesson.endsAt.toISOString(),
        room: details.room?.name ?? null,
        regular: { id: regular.id, name: regular.name },
        substitute: current ? { id: current.id, name: current.name } : null,
        phase: lessonPhase(lesson, now),
      },
      needsCover: needsCover ?? null,
      lessonReasons: substituteLessonReasons(lesson, {
        published: loaded.published,
        now,
      }),
      candidates,
      remove,
      expected: {
        substituteId: lesson.substituteTeacherId,
        startsAt: lesson.startsAt.toISOString(),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Assign, change, remove (§3.5)
// ---------------------------------------------------------------------------

export type SubstituteActionInput = {
  lessonId: string;
  /** The lesson's substitute and start when the admin opened the sheet. */
  expectedSubstituteId: string | null;
  expectedStartsAt: string;
  acknowledgedKeys: readonly string[];
  /** Optional, audit only (≤ 300 characters). */
  reason: string | null;
};

export type SubstituteActionResult =
  | { status: "done"; name: string; group: string; startsAt: string }
  /** `LESSON_CHANGED`: the lesson changed while the admin was choosing. */
  | { status: "changed" }
  /** §3.2: cancelled, unpublished, or ended more than 7 days ago. */
  | { status: "lessonRefused"; reasons: SubstituteLessonReasonCode[] }
  /** Refused or blocking reasons (busy …): pick someone else. */
  | { status: "refused"; reasons: SubstituteReason[] }
  /** Overridable reasons that need ticking first. */
  | { status: "unacknowledged"; reasons: SubstituteReason[] }
  /** Remove only: the regular teacher teaches another lesson then. */
  | { status: "regularBusy"; otherGroup: string | null };

async function inLock<T>(db: SchoolDb, fn: (tx: Tx) => Promise<T>) {
  return db.$transaction(async (tx) => {
    const school = await tx.school.findFirstOrThrow({ select: { id: true } });
    await lockTimetable(tx, school.id);
    return fn(tx);
  });
}

const sameLesson = (lesson: LessonInfo, input: SubstituteActionInput) =>
  lesson.substituteTeacherId === input.expectedSubstituteId &&
  lesson.startsAt.toISOString() ===
    new Date(input.expectedStartsAt).toISOString();

const overrides = (reasons: readonly SubstituteReason[]) =>
  reasons.map((r) => ({ code: r.code, key: r.key, params: r.params }));

/**
 * Assigns teacher `teacherId` as the lesson's substitute, or changes the
 * current one to them (§3.5). Re-checks everything under the lock and
 * writes only if the lesson is still as the admin saw it.
 */
export async function assignSubstitute(
  db: SchoolDb,
  actor: { userId: string },
  input: SubstituteActionInput & { teacherId: string },
  now: Date,
): Promise<SubstituteActionResult> {
  if (!isUuid(input.teacherId)) throw notFound();
  return inLock(db, async (tx) => {
    const loaded = await load(tx, input.lessonId);
    const { lesson, calendar, teachers } = loaded;
    // Another school's teacher is "not found", whatever the lesson.
    const teacher = teachers.find((t) => t.id === input.teacherId);
    if (!teacher) throw notFound();
    if (!sameLesson(lesson, input)) return { status: "changed" };
    const lessonReasons = substituteLessonReasons(lesson, {
      published: loaded.published,
      now,
    });
    if (lessonReasons.length > 0) {
      return { status: "lessonRefused", reasons: lessonReasons };
    }
    const reasons = checkSubstitute(calendar, lesson, teacher);
    if (reasons.some((r) => r.severity !== "overridable")) {
      return { status: "refused", reasons };
    }
    const acknowledged = new Set(input.acknowledgedKeys);
    if (reasons.some((r) => !acknowledged.has(r.key))) {
      return { status: "unacknowledged", reasons };
    }
    const facts = await loadLessonFact(tx, lesson.id);
    const { count } = await tx.lesson.updateMany({
      where: {
        id: lesson.id,
        substituteTeacherId: input.expectedSubstituteId,
        startsAt: lesson.startsAt,
      },
      data: { substituteTeacherId: teacher.id },
    });
    if (count !== 1) return { status: "changed" };

    const previous = lesson.substituteTeacherId
      ? teachers.find((t) => t.id === lesson.substituteTeacherId)!
      : null;
    const audit = await tx.auditLog.create({
      data: {
        schoolId: (await tx.school.findFirstOrThrow({ select: { id: true } }))
          .id,
        actorId: actor.userId,
        action: previous
          ? "lesson.substitute_changed"
          : "lesson.substitute_assigned",
        entityType: "Lesson",
        entityId: lesson.id,
        data: JSON.parse(
          JSON.stringify({
            lessonId: lesson.id,
            from: previous?.id ?? null,
            to: teacher.id,
            reason: input.reason,
            overridden: overrides(reasons),
            recordedAfterEnd: lesson.endsAt.getTime() <= now.getTime(),
          }),
        ),
      },
      select: { id: true },
    });
    if (facts) {
      await notify(
        tx,
        { sourceId: audit.id, actorId: actor.userId },
        assignEvents(
          facts,
          { userId: teacher.userId, name: teacher.name },
          previous ? { userId: previous.userId, name: previous.name } : null,
        ),
        now,
      );
    }
    const group = await tx.group.findFirstOrThrow({
      where: { id: lesson.groupId },
      select: { name: true },
    });
    return {
      status: "done",
      name: teacher.name,
      group: group.name,
      startsAt: lesson.startsAt.toISOString(),
    };
  });
}

/**
 * Removes the lesson's substitute: the regular teacher teaches it again
 * (§3.5). Refused while they teach another lesson then; their other
 * teacher-typed conflicts need acknowledging.
 */
export async function removeSubstitute(
  db: SchoolDb,
  actor: { userId: string },
  input: SubstituteActionInput,
  now: Date,
): Promise<SubstituteActionResult> {
  return inLock(db, async (tx) => {
    const loaded = await load(tx, input.lessonId);
    const { lesson, calendar, teachers } = loaded;
    if (!sameLesson(lesson, input) || !lesson.substituteTeacherId) {
      return { status: "changed" };
    }
    const lessonReasons = substituteLessonReasons(lesson, {
      published: loaded.published,
      now,
    });
    if (lessonReasons.length > 0) {
      return { status: "lessonRefused", reasons: lessonReasons };
    }
    const check = checkSubstituteRemoval(calendar, lesson);
    if (check.refused) {
      return { status: "regularBusy", otherGroup: check.otherGroup };
    }
    const acknowledged = new Set(input.acknowledgedKeys);
    if (check.reasons.some((r) => !acknowledged.has(r.key))) {
      return { status: "unacknowledged", reasons: check.reasons };
    }
    const facts = await loadLessonFact(tx, lesson.id);
    const { count } = await tx.lesson.updateMany({
      where: {
        id: lesson.id,
        substituteTeacherId: lesson.substituteTeacherId,
        startsAt: lesson.startsAt,
      },
      data: { substituteTeacherId: null },
    });
    if (count !== 1) return { status: "changed" };
    const removed = teachers.find((t) => t.id === lesson.substituteTeacherId)!;
    const audit = await tx.auditLog.create({
      data: {
        schoolId: (await tx.school.findFirstOrThrow({ select: { id: true } }))
          .id,
        actorId: actor.userId,
        action: "lesson.substitute_removed",
        entityType: "Lesson",
        entityId: lesson.id,
        data: JSON.parse(
          JSON.stringify({
            lessonId: lesson.id,
            from: removed.id,
            to: null,
            reason: input.reason,
            overridden: overrides(check.reasons),
            recordedAfterEnd: lesson.endsAt.getTime() <= now.getTime(),
          }),
        ),
      },
      select: { id: true },
    });
    if (facts) {
      await notify(
        tx,
        { sourceId: audit.id, actorId: actor.userId },
        removeEvents(facts, { userId: removed.userId, name: removed.name }),
        now,
      );
    }
    const group = await tx.group.findFirstOrThrow({
      where: { id: lesson.groupId },
      select: { name: true },
    });
    return {
      status: "done",
      name: removed.name,
      group: group.name,
      startsAt: lesson.startsAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Lists (design §5.2, §5.5)
// ---------------------------------------------------------------------------

export type SubstitutionRow = {
  lessonId: string;
  startsAt: string;
  endsAt: string;
  groupName: string;
  groupType: "GROUP" | "ONE_ON_ONE";
  level: string | null;
  room: string | null;
  teacher: { id: string; name: string };
  substitute: { id: string; name: string } | null;
  /** Needs cover: who can't teach it and why. */
  needsCover: NeedsCover | null;
  /** Covered / Past: who assigned the substitute, and when. */
  assigned: { by: string | null; at: string } | null;
  /** Past: still within the 7-day record window. */
  editable: boolean;
};

export type SubstitutionFilters = {
  from: IsoDate;
  to: IsoDate;
  /** Regular teacher (`TeacherProfile.id`). */
  teacherId?: string;
  levelId?: string;
};

const rowSelect = {
  id: true,
  startsAt: true,
  endsAt: true,
  teacherId: true,
  group: {
    select: { name: true, type: true, level: { select: { name: true } } },
  },
  room: { select: { name: true } },
  teacher: { select: { id: true, user: { select: { name: true } } } },
  substituteTeacher: { select: { id: true, user: { select: { name: true } } } },
} satisfies Prisma.LessonSelect;

type RowData = Prisma.LessonGetPayload<{ select: typeof rowSelect }>;

function toRow(
  row: RowData,
  extra: Partial<SubstitutionRow> = {},
): SubstitutionRow {
  return {
    lessonId: row.id,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    groupName: row.group.name,
    groupType: row.group.type,
    level: row.group.level?.name ?? null,
    room: row.room?.name ?? null,
    teacher: { id: row.teacher.id, name: row.teacher.user.name },
    substitute: row.substituteTeacher
      ? { id: row.substituteTeacher.id, name: row.substituteTeacher.user.name }
      : null,
    needsCover: null,
    assigned: null,
    editable: false,
    ...extra,
  };
}

const filterWhere = (
  filters: SubstitutionFilters,
): Prisma.LessonWhereInput => ({
  ...(filters.teacherId && isUuid(filters.teacherId)
    ? { teacherId: filters.teacherId }
    : {}),
  ...(filters.levelId && isUuid(filters.levelId)
    ? { group: { levelId: filters.levelId } }
    : {}),
});

/**
 * _Needs cover_ (§3.7): lessons in the next 8 weeks (or the filter's dates,
 * never before now) that haven't started and whose effective teacher can't
 * teach them. With `allOfTeacher` (Cover a teacher), every lesson of the
 * filtered teacher in the range is listed too.
 */
export async function listNeedsCover(
  db: SchoolDb,
  filters: SubstitutionFilters & { allOfTeacher?: boolean },
  now: Date,
): Promise<SubstitutionRow[]> {
  return db.$transaction(async (tx) => {
    const { timezone } = await tx.school.findFirstOrThrow({
      select: { timezone: true },
    });
    const from = new Date(
      Math.max(
        now.getTime(),
        zonedTimeToUtc(filters.from, 0, timezone).getTime(),
      ),
    );
    const to = zonedTimeToUtc(addDays(filters.to, 1), 0, timezone);
    if (to <= from) return [];
    const { context } = await loadSchedulingContext(
      tx,
      toZonedDateTime(from, timezone).date,
      filters.to,
    );
    const teachers = await loadTeachers(tx);
    const archived = new Set(
      teachers.filter((t) => t.archived).map((t) => t.id),
    );
    const needs = lessonsNeedingCover(
      buildCalendar(context),
      from,
      to,
      archived,
      now,
    );
    const byLesson = new Map(needs.map((n) => [n.lessonId, n]));
    const extra =
      filters.allOfTeacher && filters.teacherId && isUuid(filters.teacherId)
        ? await tx.lesson.findMany({
            where: {
              status: { not: "CANCELLED" },
              startsAt: { gte: from, lt: to },
              term: { timetablePublishedAt: { not: null } },
              OR: [
                { teacherId: filters.teacherId },
                { substituteTeacherId: filters.teacherId },
              ],
            },
            select: { id: true },
          })
        : [];
    const ids = [...new Set([...byLesson.keys(), ...extra.map((l) => l.id)])];
    const rows = await tx.lesson.findMany({
      where: {
        id: { in: ids },
        ...(filters.allOfTeacher && filters.teacherId
          ? { group: filterWhere(filters).group }
          : filterWhere(filters)),
      },
      select: rowSelect,
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    });
    return rows.map((row) =>
      toRow(row, { needsCover: byLesson.get(row.id) ?? null }),
    );
  });
}

async function assignedBy(
  db: SchoolDb,
  lessonIds: string[],
): Promise<Map<string, { by: string | null; at: string }>> {
  if (lessonIds.length === 0) return new Map();
  const logs = await db.auditLog.findMany({
    where: {
      entityType: "Lesson",
      entityId: { in: lessonIds },
      action: {
        in: ["lesson.substitute_assigned", "lesson.substitute_changed"],
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      entityId: true,
      createdAt: true,
      actor: { select: { name: true } },
    },
  });
  const out = new Map<string, { by: string | null; at: string }>();
  for (const log of logs) {
    if (!out.has(log.entityId)) {
      out.set(log.entityId, {
        by: log.actor?.name ?? null,
        at: log.createdAt.toISOString(),
      });
    }
  }
  return out;
}

/** _Covered_: lessons with a substitute that haven't ended, soonest first. */
export async function listCovered(
  db: SchoolDb,
  filters: SubstitutionFilters,
  now: Date,
): Promise<SubstitutionRow[]> {
  const { timezone } = await db.school.findFirstOrThrow({
    select: { timezone: true },
  });
  const rows = await db.lesson.findMany({
    where: {
      substituteTeacherId: { not: null },
      status: { not: "CANCELLED" },
      endsAt: { gt: now },
      startsAt: { lt: zonedTimeToUtc(addDays(filters.to, 1), 0, timezone) },
      ...filterWhere(filters),
    },
    select: rowSelect,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: 500,
  });
  const assigned = await assignedBy(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) =>
    toRow(row, { assigned: assigned.get(row.id) ?? null, editable: true }),
  );
}

/** _Past_: lessons of a term that ended with a substitute, newest first. */
export async function listPastSubstitutions(
  db: SchoolDb,
  filters: { termId: string | null; teacherId?: string; levelId?: string },
  now: Date,
): Promise<SubstitutionRow[]> {
  if (filters.termId && !isUuid(filters.termId)) return [];
  const rows = await db.lesson.findMany({
    where: {
      substituteTeacherId: { not: null },
      status: { not: "CANCELLED" },
      endsAt: { lte: now },
      ...(filters.termId ? { termId: filters.termId } : {}),
      ...filterWhere({ from: "", to: "", ...filters }),
    },
    select: rowSelect,
    orderBy: [{ startsAt: "desc" }, { id: "desc" }],
    take: 500,
  });
  const assigned = await assignedBy(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) =>
    toRow(row, {
      assigned: assigned.get(row.id) ?? null,
      editable:
        now.getTime() - new Date(row.endsAt).getTime() <=
        SUBSTITUTE_RECORD_DAYS * DAY_MS,
    }),
  );
}

/** Tab counts: lessons needing cover in the next 8 weeks, and covered ones. */
export async function substitutionCounts(
  db: SchoolDb,
  now: Date,
): Promise<{ needsCover: number; covered: number }> {
  const { timezone } = await db.school.findFirstOrThrow({
    select: { timezone: true },
  });
  const today = toZonedDateTime(now, timezone).date;
  const range = { from: today, to: addDays(today, NEEDS_COVER_DAYS) };
  const [needs, covered] = await Promise.all([
    listNeedsCover(db, range, now),
    db.lesson.count({
      where: {
        substituteTeacherId: { not: null },
        status: { not: "CANCELLED" },
        endsAt: { gt: now },
      },
    }),
  ]);
  return { needsCover: needs.length, covered };
}

// ---------------------------------------------------------------------------
// Teacher views (design §5.5)
// ---------------------------------------------------------------------------

export type TeacherSubstitutions = {
  covering: SubstitutionRow[];
  coveredForMe: SubstitutionRow[];
};

/**
 * The signed-in teacher's substitutions: lessons they cover and lessons
 * covered for them, upcoming (not ended) or past. Cancelled ones are left
 * out.
 */
export async function listTeacherSubstitutions(
  db: SchoolDb,
  teacherId: string,
  { past }: { past: boolean },
  now: Date,
): Promise<TeacherSubstitutions> {
  const when: Prisma.LessonWhereInput = past
    ? { endsAt: { lte: now } }
    : { endsAt: { gt: now } };
  const base: Prisma.LessonWhereInput = {
    status: { not: "CANCELLED" },
    term: { timetablePublishedAt: { not: null } },
    ...when,
  };
  const order: Prisma.LessonOrderByWithRelationInput[] = past
    ? [{ startsAt: "desc" }, { id: "desc" }]
    : [{ startsAt: "asc" }, { id: "asc" }];
  const [covering, coveredForMe] = await Promise.all([
    db.lesson.findMany({
      where: { ...base, substituteTeacherId: teacherId },
      select: rowSelect,
      orderBy: order,
      take: 200,
    }),
    db.lesson.findMany({
      where: { ...base, teacherId, substituteTeacherId: { not: null } },
      select: rowSelect,
      orderBy: order,
      take: 200,
    }),
  ]);
  return {
    covering: covering.map((r) => toRow(r)),
    coveredForMe: coveredForMe.map((r) => toRow(r)),
  };
}

/** The dashboard card: lessons the teacher covers in the next 14 days. */
export async function upcomingCover(
  db: SchoolDb,
  teacherId: string,
  now: Date,
): Promise<{ count: number; next: SubstitutionRow[] }> {
  const where: Prisma.LessonWhereInput = {
    substituteTeacherId: teacherId,
    status: { not: "CANCELLED" },
    endsAt: { gt: now },
    startsAt: { lt: new Date(now.getTime() + 14 * DAY_MS) },
    term: { timetablePublishedAt: { not: null } },
  };
  const [count, next] = await Promise.all([
    db.lesson.count({ where }),
    db.lesson.findMany({
      where,
      select: rowSelect,
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: 2,
    }),
  ]);
  return { count, next: next.map((r) => toRow(r)) };
}
