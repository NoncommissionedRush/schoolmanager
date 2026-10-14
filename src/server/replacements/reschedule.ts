// 1-on-1 reschedule: the student flow and the admin reschedule (CARM-43,
// docs/architecture/replacements.md §3, §7, §8). The source lesson is
// cancelled and the new time is a new ad-hoc lesson of the same group with
// `rescheduledFromId`; the credit spent on it points at it
// (`rescheduledLessonId`). Every write takes the timetable lock and
// re-checks with the pure rules (checkReschedule, rescheduleOptions).

import type { Prisma } from "@/generated/prisma/client";
import { AdminError, msg } from "@/server/admin/result";
import { isUuid } from "@/server/lessons/access";
import {
  addDays,
  buildCalendar,
  type Calendar,
  checkReschedule,
  type Conflict,
  creditExpiry,
  creditState,
  decideAdminReschedule,
  earnsCredit,
  isFreeTime,
  isoWeekday,
  RESCHEDULE_GRID_MINUTES,
  RESCHEDULED,
  SCHOOL_CANCELLED,
  type RescheduleReason,
  type RescheduleRequest,
  rescheduleOptions,
  STUDENT_CANCELLED,
  toZonedDateTime,
  validUntilOf,
  zonedTimeToUtc,
} from "@/server/scheduling";
import {
  loadSchedulingContext,
  type SchoolDb,
  type Tx,
} from "@/server/timetable/service";
import { isMemberAt, membersAt } from "@/server/timetable/week";

import { loadAttending } from "./booking";
import { releaseCancelledLessons } from "./release";
import {
  chainRoot,
  inLockedTransaction,
  reportAbsenceInTx,
  type SchoolSettings,
} from "./service";

const MINUTE_MS = 60_000;
const notFound = () => new AdminError(msg("common.error.notFound"));
const refusal = (code: string) =>
  new AdminError(msg(`reschedule.errors.${code}`));

/** What the student reschedules: a lesson of theirs, or a credit. */
export type RescheduleSource = { lessonId: string } | { creditId: string };

const lessonSelect = {
  id: true,
  termId: true,
  groupId: true,
  teacherId: true,
  roomId: true,
  timetableSlotId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  rescheduledFromId: true,
  term: { select: { timetablePublishedAt: true } },
  group: { select: { type: true } },
  room: { select: { kind: true } },
  timetableSlot: { select: { roomId: true } },
  teacher: { select: { user: { select: { name: true } } } },
  spentCredit: {
    select: { id: true, status: true, expiresAt: true, studentId: true },
  },
  rescheduledTo: { select: { id: true } },
} satisfies Prisma.LessonSelect;

type LessonRow = Prisma.LessonGetPayload<{ select: typeof lessonSelect }>;

/** The last lesson of a reschedule chain, following `rescheduledTo`. */
async function chainTail(tx: Tx | SchoolDb, lessonId: string) {
  let id = lessonId;
  for (let i = 0; i < 1_000; i++) {
    const next = await tx.lesson.findFirst({
      where: { rescheduledFromId: id },
      select: { id: true },
    });
    if (!next) break;
    id = next.id;
  }
  return id;
}

/**
 * Rooms to try, in order (§7 _Room_): the missed lesson's, the slot's,
 * then every other non-archived room of the same kind by name. A lesson
 * without a room keeps having none.
 */
async function roomPreference(
  tx: Tx | SchoolDb,
  missed: Pick<LessonRow, "roomId" | "room" | "timetableSlot">,
): Promise<(string | null)[]> {
  if (!missed.roomId || !missed.room) return [null];
  const rooms = await tx.room.findMany({
    where: { kind: missed.room.kind, archivedAt: null },
    select: { id: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const order = [
    missed.roomId,
    missed.timetableSlot?.roomId ?? null,
    ...rooms.map((r) => r.id),
  ].filter((id): id is string => id !== null);
  return [...new Set(order)];
}

type Setup = {
  /** What happens on save. */
  kind: "fromCredit" | "moveRescheduled" | "cancelAndMove";
  student: { id: string; userId: string };
  /** The scheduled lesson being moved (cancelAndMove, moveRescheduled). */
  lesson: LessonRow | null;
  /** The missed lesson whose duration, teacher and room carry over. */
  missed: LessonRow;
  credit: { id: string | null; expiresAt: Date; sourceDate: string };
  request: RescheduleRequest;
  usual: { weekday: number; startMinute: number };
  rooms: (string | null)[];
  calendar: Calendar;
};

/**
 * Loads everything a student reschedule needs (§7 _Flows_): from an
 * AVAILABLE 1-on-1 credit, from a rescheduled lesson with its credit
 * (moved again with the same credit), or from a scheduled 1-on-1 before
 * its cutoff (cancelled, credit earned and spent in one step). Anything
 * the student may not use is "not found" or refused.
 */
async function setupStudent(
  tx: Tx | SchoolDb,
  school: SchoolSettings,
  userId: string,
  source: RescheduleSource,
  now: Date,
): Promise<Setup> {
  const student = await tx.studentProfile.findFirst({
    where: { userId },
    select: {
      id: true,
      userId: true,
      groupMemberships: {
        select: { groupId: true, joinedAt: true, leftAt: true },
      },
    },
  });
  if (!student) throw notFound();
  const tz = school.timezone;

  let kind: Setup["kind"];
  let lesson: LessonRow | null = null;
  let missed: LessonRow;
  let credit: Setup["credit"];
  let creditInput: RescheduleRequest["credit"];

  if ("creditId" in source) {
    if (!isUuid(source.creditId)) throw notFound();
    const row = await tx.makeupCredit.findFirst({
      where: { id: source.creditId, studentId: student.id },
      select: {
        id: true,
        studentId: true,
        status: true,
        expiresAt: true,
        sourceLesson: { select: lessonSelect },
      },
    });
    if (!row || row.sourceLesson.group.type !== "ONE_ON_ONE") throw notFound();
    if (creditState(row, now) !== "AVAILABLE") {
      throw refusal("CREDIT_UNAVAILABLE");
    }
    kind = "fromCredit";
    missed = row.sourceLesson;
    credit = {
      id: row.id,
      expiresAt: row.expiresAt,
      sourceDate: toZonedDateTime(missed.startsAt, tz).date,
    };
    creditInput = {
      studentId: row.studentId,
      status: row.status,
      expiresAt: row.expiresAt,
      sourceGroupId: missed.groupId,
      spentOnMoving: false,
    };
  } else {
    if (!isUuid(source.lessonId)) throw notFound();
    const row = await tx.lesson.findFirst({
      where: { id: source.lessonId },
      select: lessonSelect,
    });
    if (
      !row ||
      row.group.type !== "ONE_ON_ONE" ||
      row.term.timetablePublishedAt === null ||
      !isMemberAt(student.groupMemberships, row.groupId, row.startsAt)
    ) {
      throw notFound();
    }
    if (row.status !== "SCHEDULED") throw refusal("LESSON_CANCELLED");
    if (row.startsAt.getTime() <= now.getTime()) {
      throw refusal("LESSON_STARTED");
    }
    // Only before the cutoff (§3); after it neither is offered.
    if (!earnsCredit(row.startsAt, now, school.absenceCutoffMinutes)) {
      throw refusal("CUTOFF_PASSED");
    }
    const reported = await tx.absenceReport.count({
      where: { lessonId: row.id, studentId: student.id },
    });
    if (reported > 0) throw refusal("ALREADY_REPORTED");
    lesson = row;
    missed = row;
    const spent =
      row.spentCredit?.status === "USED" &&
      row.spentCredit.studentId === student.id
        ? row.spentCredit
        : null;
    if (spent) {
      kind = "moveRescheduled";
      const source = await tx.makeupCredit.findFirstOrThrow({
        where: { id: spent.id },
        select: { sourceLesson: { select: { startsAt: true } } },
      });
      credit = {
        id: spent.id,
        expiresAt: spent.expiresAt,
        sourceDate: toZonedDateTime(source.sourceLesson.startsAt, tz).date,
      };
      creditInput = {
        studentId: spent.studentId,
        status: "USED",
        expiresAt: spent.expiresAt,
        sourceGroupId: row.groupId,
        spentOnMoving: true,
      };
    } else {
      kind = "cancelAndMove";
      // The credit this cancellation will earn (an admin-moved lesson
      // counts from its chain root, §3).
      const anchor = row.rescheduledFromId
        ? await chainRoot(tx as Tx, row)
        : row;
      const expiry = creditExpiry(
        anchor.startsAt,
        school.makeupCreditValidDays,
        tz,
      );
      credit = {
        id: null,
        expiresAt: expiry.expiresAt,
        sourceDate: toZonedDateTime(row.startsAt, tz).date,
      };
      creditInput = {
        studentId: student.id,
        status: "AVAILABLE",
        expiresAt: expiry.expiresAt,
        sourceGroupId: row.groupId,
        spentOnMoving: false,
      };
    }
  }

  const root = missed.rescheduledFromId
    ? await chainRoot(tx as Tx, missed)
    : missed;
  const rootLocal = toZonedDateTime(root.startsAt, tz);
  const { context, publishedTermIds } = await loadSchedulingContext(
    tx as Tx,
    toZonedDateTime(now, tz).date,
    addDays(toZonedDateTime(credit.expiresAt, tz).date, 1),
  );
  const attending = await loadAttending(
    tx,
    { id: student.id, memberships: student.groupMemberships },
    now,
    credit.expiresAt,
  );
  return {
    kind,
    student: { id: student.id, userId: student.userId },
    lesson,
    missed,
    credit,
    request: {
      mode: "student",
      groupId: missed.groupId,
      teacherId: missed.teacherId,
      movingLessonId: lesson?.id ?? null,
      movingStartsAt: lesson?.startsAt ?? null,
      durationMinutes:
        (missed.endsAt.getTime() - missed.startsAt.getTime()) / MINUTE_MS,
      credit: creditInput,
      studentId: student.id,
      cutoffMinutes: school.absenceCutoffMinutes,
      publishedTermIds,
      attending,
    },
    usual: {
      weekday: isoWeekday(rootLocal.date),
      startMinute: rootLocal.minute,
    },
    rooms: await roomPreference(tx, missed),
    calendar: buildCalendar(context),
  };
}

export type RescheduleSheet = {
  teacherName: string;
  /** The lesson being moved; null when rescheduling from a credit. */
  current: { date: string; startMinute: number; endMinute: number } | null;
  sourceDate: string;
  validUntil: string;
  /** Moving a rescheduled lesson again: the same credit moves with it. */
  again: boolean;
  options: {
    startsAt: string;
    date: string;
    startMinute: number;
    endMinute: number;
    roomName: string | null;
    usual: boolean;
  }[];
};

function localTimes(startsAt: Date, endsAt: Date, timeZone: string) {
  const start = toZonedDateTime(startsAt, timeZone);
  const end = toZonedDateTime(endsAt, timeZone);
  return {
    date: start.date,
    startMinute: start.minute,
    endMinute: end.date === start.date ? end.minute : 24 * 60,
  };
}

async function sheetOf(
  tx: Tx | SchoolDb,
  setup: Setup,
  school: SchoolSettings,
  now: Date,
): Promise<RescheduleSheet> {
  const tz = school.timezone;
  const options = rescheduleOptions(
    setup.calendar,
    setup.request,
    setup.usual,
    setup.rooms,
    now,
  );
  const roomIds = [
    ...new Set(options.flatMap((o) => (o.roomId ? [o.roomId] : []))),
  ];
  const rooms = await tx.room.findMany({
    where: { id: { in: roomIds } },
    select: { id: true, name: true },
  });
  const roomName = new Map(rooms.map((r) => [r.id, r.name]));
  return {
    teacherName: setup.missed.teacher.user.name,
    current: setup.lesson
      ? localTimes(setup.lesson.startsAt, setup.lesson.endsAt, tz)
      : null,
    sourceDate: setup.credit.sourceDate,
    validUntil: validUntilOf(setup.credit.expiresAt, tz),
    again: setup.kind === "moveRescheduled",
    options: options.map((o) => ({
      startsAt: o.startsAt.toISOString(),
      ...localTimes(o.startsAt, o.endsAt, tz),
      roomName: o.roomId ? (roomName.get(o.roomId) ?? null) : null,
      usual: o.usual,
    })),
  };
}

async function schoolSettings(db: Tx | SchoolDb): Promise<SchoolSettings> {
  return db.school.findFirstOrThrow({
    select: {
      id: true,
      timezone: true,
      absenceCutoffMinutes: true,
      makeupCreditValidDays: true,
    },
  });
}

/** The Reschedule sheet (absences.md §5.3): up to 20 free times. */
export async function loadRescheduleSheet(
  db: SchoolDb,
  student: { userId: string },
  source: RescheduleSource,
  now: Date,
): Promise<RescheduleSheet> {
  return db.$transaction(async (tx) => {
    const school = await schoolSettings(tx);
    const setup = await setupStudent(tx, school, student.userId, source, now);
    return sheetOf(tx, setup, school, now);
  });
}

export type RescheduleResult =
  | { status: "rescheduled"; lessonId: string; startsAt: string }
  /** The time was taken meanwhile: the fresh list (absences.md §5.3). */
  | { status: "taken"; sheet: RescheduleSheet };

/** Creates the new ad-hoc lesson of a reschedule (§7). */
async function createRescheduled(
  tx: Tx,
  school: SchoolSettings,
  input: {
    termId: string;
    groupId: string;
    teacherId: string;
    roomId: string | null;
    startsAt: Date;
    endsAt: Date;
    rescheduledFromId: string;
  },
) {
  return tx.lesson.create({
    data: {
      schoolId: school.id,
      termId: input.termId,
      timetableSlotId: null,
      occurrenceDate: null,
      groupId: input.groupId,
      teacherId: input.teacherId,
      roomId: input.roomId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      rescheduledFromId: input.rescheduledFromId,
    },
    select: { id: true },
  });
}

/**
 * The student moves their 1-on-1 to `startsAt` (one of the offered
 * times). Under the lock everything is loaded and checked again; the room
 * is picked by the server. Never mints a second credit: a rescheduled
 * lesson moves with the credit already spent on it (§3).
 */
export async function rescheduleLesson(
  db: SchoolDb,
  actor: { userId: string },
  input: RescheduleSource & { startsAt: string; reason?: string | null },
  now: Date,
): Promise<RescheduleResult> {
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw notFound();
  return inLockedTransaction(db, async (tx, school) => {
    const setup = await setupStudent(tx, school, actor.userId, input, now);
    // Only times the sheet can offer: on the grid, never the lesson's own.
    const local = toZonedDateTime(startsAt, school.timezone);
    if (
      local.minute % RESCHEDULE_GRID_MINUTES !== 0 ||
      startsAt.getTime() % MINUTE_MS !== 0 ||
      startsAt.getTime() === setup.lesson?.startsAt.getTime()
    ) {
      return { status: "taken", sheet: await sheetOf(tx, setup, school, now) };
    }
    const endsAt = new Date(
      startsAt.getTime() + setup.request.durationMinutes * MINUTE_MS,
    );
    let chosen: { roomId: string | null; termId: string } | null = null;
    for (const roomId of setup.rooms) {
      const check = checkReschedule(
        setup.calendar,
        setup.request,
        { startsAt, endsAt, roomId },
        now,
      );
      if (isFreeTime(check) && check.termId) {
        chosen = { roomId, termId: check.termId };
        break;
      }
    }
    if (!chosen) {
      return { status: "taken", sheet: await sheetOf(tx, setup, school, now) };
    }

    let creditId = setup.credit.id;
    let fromLessonId: string;
    if (setup.kind === "cancelAndMove") {
      const reported = await reportAbsenceInTx(
        tx,
        school,
        { userId: actor.userId, role: "STUDENT" },
        {
          lessonId: setup.lesson!.id,
          reason: input.reason ?? null,
          expectCredit: true,
        },
        now,
      );
      if (reported.status === "cutoffPassed" || !reported.credit) {
        throw refusal("CUTOFF_PASSED");
      }
      creditId = reported.credit.id;
      fromLessonId = setup.lesson!.id;
    } else if (setup.kind === "moveRescheduled") {
      const { count } = await tx.lesson.updateMany({
        where: { id: setup.lesson!.id, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelReason: STUDENT_CANCELLED },
      });
      if (count !== 1) throw refusal("LESSON_CANCELLED");
      fromLessonId = setup.lesson!.id;
    } else {
      // From a credit: continue the chain where it ended.
      fromLessonId = await chainTail(tx, setup.missed.id);
    }

    const lesson = await createRescheduled(tx, school, {
      termId: chosen.termId,
      groupId: setup.missed.groupId,
      teacherId: setup.missed.teacherId,
      roomId: chosen.roomId,
      startsAt,
      endsAt,
      rescheduledFromId: fromLessonId,
    });
    // Conditional: a credit spent or expired meanwhile is never spent twice.
    const { count } = await tx.makeupCredit.updateMany({
      where:
        setup.kind === "moveRescheduled"
          ? { id: creditId!, status: "USED", rescheduledLessonId: fromLessonId }
          : { id: creditId!, status: "AVAILABLE", expiresAt: { gt: now } },
      data: { status: "USED", usedAt: now, rescheduledLessonId: lesson.id },
    });
    if (count !== 1) throw refusal("CREDIT_UNAVAILABLE");

    await tx.auditLog.create({
      data: {
        schoolId: school.id,
        actorId: actor.userId,
        action: "lesson.rescheduled",
        entityType: "Lesson",
        entityId: lesson.id,
        data: {
          by: "student",
          studentId: setup.student.id,
          creditId,
          fromLessonId,
          from: setup.lesson?.startsAt.toISOString() ?? null,
          to: startsAt.toISOString(),
          roomId: chosen.roomId,
        },
      },
    });
    return {
      status: "rescheduled",
      lessonId: lesson.id,
      startsAt: startsAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Admin reschedule (§7, owner decision 2026-10-14)
// ---------------------------------------------------------------------------

type AdminRescheduleFields = {
  /** Local date and time in the school's time zone. */
  date: string;
  startMinute: number;
  durationMinutes: number;
  roomId: string | null;
  acknowledgedKeys: readonly string[];
  note: string | null;
};

/**
 * What the admin moves: a scheduled 1-on-1 lesson, or (CARM-47) the
 * student's AVAILABLE 1-on-1 credit, spent on a new lesson for them.
 */
export type AdminRescheduleInput = AdminRescheduleFields &
  ({ lessonId: string } | { creditId: string });

export type AdminRescheduleResult =
  | { status: "rescheduled"; lessonId: string; startsAt: string }
  | {
      status: "conflicts";
      blocking: boolean;
      conflicts: Conflict[];
      reasons: (RescheduleReason & {
        clashes?: { group: string; date: string; startMinute: number }[];
      })[];
    };

const adminLessonSelect = {
  ...lessonSelect,
  group: {
    select: {
      type: true,
      memberships: {
        select: {
          studentId: true,
          joinedAt: true,
          leftAt: true,
          student: {
            select: {
              groupMemberships: {
                select: { groupId: true, joinedAt: true, leftAt: true },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.LessonSelect;

/** What an admin reschedule moves and for whom, loaded under the lock. */
async function loadAdminSource(tx: Tx, input: AdminRescheduleInput, now: Date) {
  if ("creditId" in input) {
    const credit = await tx.makeupCredit.findFirst({
      where: { id: input.creditId },
      select: {
        id: true,
        studentId: true,
        status: true,
        expiresAt: true,
        sourceLesson: { select: lessonSelect },
        student: {
          select: {
            groupMemberships: {
              select: { groupId: true, joinedAt: true, leftAt: true },
            },
          },
        },
      },
    });
    // Only 1-on-1 credits move a lesson; group ones book a replacement.
    if (!credit || credit.sourceLesson.group.type !== "ONE_ON_ONE") {
      throw notFound();
    }
    if (creditState(credit, now) !== "AVAILABLE") {
      throw refusal("CREDIT_UNAVAILABLE");
    }
    return {
      moving: null,
      missed: credit.sourceLesson,
      student: {
        id: credit.studentId,
        memberships: credit.student.groupMemberships,
      },
      credit: {
        id: credit.id,
        studentId: credit.studentId,
        status: credit.status,
        expiresAt: credit.expiresAt,
        sourceGroupId: credit.sourceLesson.groupId,
        spentOnMoving: false,
      },
    };
  }
  const lesson = await tx.lesson.findFirst({
    where: { id: input.lessonId },
    select: adminLessonSelect,
  });
  if (!lesson || lesson.group.type !== "ONE_ON_ONE") throw notFound();
  if (lesson.status !== "SCHEDULED") throw refusal("LESSON_CANCELLED");
  if (lesson.startsAt.getTime() <= now.getTime()) {
    throw refusal("LESSON_STARTED");
  }
  const member = membersAt(lesson.group.memberships, lesson.startsAt)[0];
  if (!member) throw refusal("NO_STUDENT");
  const spent =
    lesson.spentCredit?.status === "USED" ? lesson.spentCredit : null;
  return {
    moving: lesson,
    missed: lesson,
    student: {
      id: member.studentId,
      memberships: member.student.groupMemberships,
    },
    credit: spent && {
      id: spent.id,
      studentId: spent.studentId,
      status: spent.status,
      expiresAt: spent.expiresAt,
      sourceGroupId: lesson.groupId,
      spentOnMoving: true,
    },
  };
}

/**
 * An admin moves any upcoming scheduled 1-on-1, also after the cutoff, on
 * a lesson with a late absence or one that is itself a reschedule. No
 * credit is created or spent; a credit spent on the source moves with it.
 *
 * From a credit (CARM-47, §7 _Admin reschedule_) the admin runs the
 * student's "reschedule from a credit" for them: a new lesson continues
 * the credit's chain and the credit is spent on it. A time on or after the
 * credit's expiry needs acknowledging like a conflict.
 *
 * Blocking conflicts, OUTSIDE_TERM and an unusable credit refuse;
 * overridable conflicts, CREDIT_EXPIRES_FIRST and STUDENT_CLASH need each
 * key acknowledged.
 */
export async function rescheduleByAdmin(
  db: SchoolDb,
  actor: { userId: string },
  input: AdminRescheduleInput,
  now: Date,
): Promise<AdminRescheduleResult> {
  const sourceId = "creditId" in input ? input.creditId : input.lessonId;
  if (!isUuid(sourceId) || (input.roomId !== null && !isUuid(input.roomId))) {
    throw notFound();
  }
  return inLockedTransaction(db, async (tx, school) => {
    const tz = school.timezone;
    if (input.roomId) {
      const room = await tx.room.findFirst({
        where: { id: input.roomId },
        select: { id: true },
      });
      if (!room) throw notFound();
    }
    const { moving, missed, student, credit } = await loadAdminSource(
      tx,
      input,
      now,
    );

    const startsAt = zonedTimeToUtc(input.date, input.startMinute, tz);
    const endsAt = new Date(
      startsAt.getTime() + input.durationMinutes * MINUTE_MS,
    );
    const { context, publishedTermIds } = await loadSchedulingContext(
      tx,
      input.date,
      input.date,
    );
    const attending = await loadAttending(
      tx,
      { id: student.id, memberships: student.memberships },
      startsAt,
      endsAt,
    );
    const calendar = buildCalendar(context);
    const check = checkReschedule(
      calendar,
      {
        mode: "admin",
        groupId: missed.groupId,
        teacherId: missed.teacherId,
        movingLessonId: moving?.id ?? null,
        durationMinutes: input.durationMinutes,
        credit,
        studentId: student.id,
        cutoffMinutes: school.absenceCutoffMinutes,
        publishedTermIds,
        attending,
      },
      { startsAt, endsAt, roomId: input.roomId },
      now,
    );
    const decision = decideAdminReschedule(check, input.acknowledgedKeys);
    if (!decision.ok) {
      const clashIds = check.reasons.flatMap((r) => r.lessonIds ?? []);
      const clashes = await tx.lesson.findMany({
        where: { id: { in: clashIds } },
        select: { id: true, startsAt: true, group: { select: { name: true } } },
      });
      const byId = new Map(
        clashes.map((c) => {
          const local = toZonedDateTime(c.startsAt, tz);
          return [
            c.id,
            {
              group: c.group.name,
              date: local.date,
              startMinute: local.minute,
            },
          ];
        }),
      );
      return {
        status: "conflicts",
        blocking: decision.reason === "BLOCKING",
        conflicts: check.conflicts,
        reasons: check.reasons.map((r) => ({
          ...r,
          clashes: r.lessonIds?.flatMap((id) => byId.get(id) ?? []),
        })),
      };
    }

    let fromLessonId: string;
    if (moving) {
      const { count } = await tx.lesson.updateMany({
        where: { id: moving.id, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelReason: RESCHEDULED },
      });
      if (count !== 1) throw refusal("LESSON_CANCELLED");
      fromLessonId = moving.id;
    } else {
      // From a credit: continue the chain where it ended, as the student would.
      fromLessonId = await chainTail(tx, missed.id);
    }
    const created = await createRescheduled(tx, school, {
      termId: check.termId!,
      groupId: missed.groupId,
      teacherId: missed.teacherId,
      roomId: input.roomId,
      startsAt,
      endsAt,
      rescheduledFromId: fromLessonId,
    });
    if (credit) {
      // Conditional: a credit spent or expired meanwhile is never spent twice.
      const { count } = await tx.makeupCredit.updateMany({
        where: credit.spentOnMoving
          ? { id: credit.id, status: "USED" }
          : { id: credit.id, status: "AVAILABLE", expiresAt: { gt: now } },
        data: credit.spentOnMoving
          ? { rescheduledLessonId: created.id }
          : { status: "USED", usedAt: now, rescheduledLessonId: created.id },
      });
      if (count !== 1) throw refusal("CREDIT_UNAVAILABLE");
    }
    await tx.auditLog.create({
      data: {
        schoolId: school.id,
        actorId: actor.userId,
        action: "lesson.rescheduled",
        entityType: "Lesson",
        entityId: created.id,
        data: JSON.parse(
          JSON.stringify({
            by: "admin",
            studentId: student.id,
            creditId: credit?.id ?? null,
            /** The admin spent the student's AVAILABLE credit (CARM-47). */
            creditSpent: credit !== null && !credit.spentOnMoving,
            fromLessonId,
            from: (moving ?? missed).startsAt.toISOString(),
            to: startsAt.toISOString(),
            roomId: input.roomId,
            note: input.note,
            acknowledged: [
              ...decision.overriddenConflicts.map((c) => ({
                type: c.type,
                key: c.key,
                params: c.params,
              })),
              ...decision.overriddenReasons.map((r) => ({
                type: r.code,
                key: r.key,
              })),
            ],
          }),
        ),
      },
    });
    return {
      status: "rescheduled",
      lessonId: created.id,
      startsAt: startsAt.toISOString(),
    };
  });
}

/**
 * An admin cancels a rescheduled 1-on-1 (§7 _Admin cancels_): the lesson is
 * cancelled by the school and the credit spent on it comes back with grace
 * (§4).
 */
export async function cancelRescheduledLesson(
  db: SchoolDb,
  actor: { userId: string },
  lessonId: string,
  now: Date,
): Promise<{ creditReleased: boolean }> {
  if (!isUuid(lessonId)) throw notFound();
  return inLockedTransaction(db, async (tx, school) => {
    const lesson = await tx.lesson.findFirst({
      where: { id: lessonId },
      select: {
        id: true,
        status: true,
        startsAt: true,
        rescheduledFromId: true,
      },
    });
    if (!lesson || !lesson.rescheduledFromId) throw notFound();
    if (lesson.status !== "SCHEDULED") throw refusal("LESSON_CANCELLED");
    if (lesson.startsAt.getTime() <= now.getTime()) {
      throw refusal("LESSON_STARTED");
    }
    await tx.lesson.update({
      where: { id: lesson.id },
      data: { status: "CANCELLED", cancelReason: SCHOOL_CANCELLED },
    });
    const released = await releaseCancelledLessons(
      tx,
      school.id,
      [lesson.id],
      school.timezone,
      now,
      actor.userId,
    );
    await tx.auditLog.create({
      data: {
        schoolId: school.id,
        actorId: actor.userId,
        action: "lesson.cancelled",
        entityType: "Lesson",
        entityId: lesson.id,
        data: { reason: SCHOOL_CANCELLED, creditsReleased: released.credits },
      },
    });
    return { creditReleased: released.credits > 0 };
  });
}

/** What the admin reschedule dialog needs: the lesson and the rooms. */
export async function loadAdminRescheduleInfo(
  db: SchoolDb,
  lessonId: string,
  now: Date,
) {
  if (!isUuid(lessonId)) return null;
  const school = await schoolSettings(db);
  const lesson = await db.lesson.findFirst({
    where: { id: lessonId },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      roomId: true,
      rescheduledFromId: true,
      group: { select: { type: true } },
      spentCredit: { select: { id: true, status: true } },
    },
  });
  if (!lesson || lesson.group.type !== "ONE_ON_ONE") return null;
  const rooms = await db.room.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const times = localTimes(lesson.startsAt, lesson.endsAt, school.timezone);
  return {
    lessonId: lesson.id,
    ...times,
    durationMinutes:
      (lesson.endsAt.getTime() - lesson.startsAt.getTime()) / MINUTE_MS,
    roomId: lesson.roomId,
    rooms,
    canReschedule:
      lesson.status === "SCHEDULED" &&
      lesson.startsAt.getTime() > now.getTime(),
    /** A rescheduled lesson the admin can cancel (credit back with grace). */
    canCancel:
      lesson.rescheduledFromId !== null &&
      lesson.status === "SCHEDULED" &&
      lesson.startsAt.getTime() > now.getTime(),
    hasCredit: lesson.spentCredit?.status === "USED",
  };
}
