// Timetable service: what the timetable editor's server actions call. It
// loads data through the school-scoped client, asks the pure scheduling
// module (src/server/scheduling) for conflicts and lesson plans, and applies
// them in one transaction per action. Callers check `requireRole("ADMIN")`
// first and pass `getSchoolScopedDb()`. See docs/architecture/scheduling.md.

import type { scopeToSchool } from "@/server/db/school-scope";
import {
  addDays,
  buildCalendar,
  checkLesson,
  checkSlot,
  checkTimetable,
  type Conflict,
  decideSave,
  type ExistingLesson,
  fromIsoDate,
  holidaysOfTerm,
  type IsoDate,
  type LessonCandidate,
  type LessonSyncPlan,
  planLessonSync,
  planSlotEdit,
  type SchedulingContext,
  type SlotChange,
  type SlotInfo,
  toIsoDate,
  toZonedDateTime,
} from "@/server/scheduling";

export type SchoolDb = ReturnType<typeof scopeToSchool>;
type Tx = Parameters<Parameters<SchoolDb["$transaction"]>[0]>[0];

/** The signed-in admin performing the change (`User.id`), for the audit log. */
export type Actor = { userId: string };

export type SchedulingErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "EFFECTIVE_DATE_IN_PAST"
  | "NOT_PUBLISHED"
  | "TERM_HAS_LESSONS"
  | "SLOT_HAS_LESSONS";

/** A request the service refuses; `code` maps to `scheduling.errors.<code>`. */
export class SchedulingError extends Error {
  constructor(
    readonly code: SchedulingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SchedulingError";
  }
}

export type LessonChanges = {
  created: number;
  removed: number;
  cancelled: number;
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type Loaded = {
  context: SchedulingContext;
  term: SchedulingContext["terms"][number] & { publishedAt: Date | null };
  schoolId: string;
  today: IsoDate;
};

const iso = (date: Date) => toIsoDate(date);
const isoOrNull = (date: Date | null) => (date ? toIsoDate(date) : null);

function toSlotInfo(slot: {
  id: string;
  termId: string;
  groupId: string;
  teacherId: string;
  roomId: string | null;
  weekday: number;
  startMinute: number;
  endMinute: number;
  validFrom: Date | null;
  validUntil: Date | null;
}): SlotInfo {
  return {
    id: slot.id,
    termId: slot.termId,
    groupId: slot.groupId,
    teacherId: slot.teacherId,
    roomId: slot.roomId,
    weekday: slot.weekday,
    startMinute: slot.startMinute,
    endMinute: slot.endMinute,
    validFrom: isoOrNull(slot.validFrom),
    validUntil: isoOrNull(slot.validUntil),
  };
}

/**
 * Everything the checker needs for `termId`: the term and every term
 * overlapping it, with their slots, lessons and holidays, plus the school's
 * groups, rooms, people and availability.
 */
async function load(tx: Tx, termId: string, now: Date): Promise<Loaded> {
  const school = await tx.school.findFirstOrThrow({
    select: {
      id: true,
      timezone: true,
      teachingWeekdays: true,
      dayStartMinute: true,
      dayEndMinute: true,
    },
  });
  const term = await tx.term.findUnique({ where: { id: termId } });
  if (!term) throw new SchedulingError("NOT_FOUND", `Term ${termId} not found`);

  const terms = await tx.term.findMany({
    where: {
      startDate: { lte: term.endDate },
      endDate: { gte: term.startDate },
    },
    select: { id: true, name: true, startDate: true, endDate: true },
  });
  const termIds = terms.map((t) => t.id);
  const [holidays, slots, lessons, groups, rooms, teachers, students, rules] =
    await Promise.all([
      tx.holiday.findMany({
        where: { OR: [{ termId: { in: termIds } }, { termId: null }] },
      }),
      tx.timetableSlot.findMany({ where: { termId: { in: termIds } } }),
      tx.lesson.findMany({
        where: { termId: { in: termIds } },
        select: {
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
        },
      }),
      tx.group.findMany({
        select: {
          id: true,
          name: true,
          type: true,
          capacity: true,
          deletedAt: true,
          memberships: { where: { leftAt: null }, select: { studentId: true } },
        },
      }),
      tx.room.findMany({
        select: {
          id: true,
          name: true,
          kind: true,
          capacity: true,
          archivedAt: true,
        },
      }),
      tx.teacherProfile.findMany({
        select: { id: true, user: { select: { name: true } } },
      }),
      tx.studentProfile.findMany({
        select: { id: true, user: { select: { name: true } } },
      }),
      tx.teacherAvailability.findMany(),
    ]);

  return {
    schoolId: school.id,
    today: toZonedDateTime(now, school.timezone).date,
    term: {
      id: term.id,
      name: term.name,
      startDate: iso(term.startDate),
      endDate: iso(term.endDate),
      publishedAt: term.timetablePublishedAt,
    },
    context: {
      school: {
        timeZone: school.timezone,
        teachingWeekdays: school.teachingWeekdays,
        dayStartMinute: school.dayStartMinute,
        dayEndMinute: school.dayEndMinute,
      },
      terms: terms.map((t) => ({
        id: t.id,
        name: t.name,
        startDate: iso(t.startDate),
        endDate: iso(t.endDate),
      })),
      holidays: holidays.map((h) => ({
        id: h.id,
        name: h.name,
        termId: h.termId,
        startDate: iso(h.startDate),
        endDate: iso(h.endDate),
      })),
      slots: slots.map(toSlotInfo),
      lessons: lessons.map((l) => ({
        ...l,
        occurrenceDate: isoOrNull(l.occurrenceDate),
      })),
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        type: g.type,
        capacity: g.capacity,
        studentIds: g.memberships.map((m) => m.studentId),
        archived: g.deletedAt !== null,
      })),
      rooms: rooms.map(({ archivedAt, ...r }) => ({
        ...r,
        archived: archivedAt !== null,
      })),
      teachers: teachers.map((t) => ({ id: t.id, name: t.user.name })),
      students: students.map((s) => ({ id: s.id, name: s.user.name })),
      availability: rules.map((r) => ({
        id: r.id,
        teacherId: r.teacherId,
        kind: r.kind,
        weekday: r.weekday,
        date: isoOrNull(r.date),
        startMinute: r.startMinute,
        endMinute: r.endMinute,
      })),
    },
  };
}

/**
 * Serializes timetable changes per school, so two admins saving at once
 * cannot both pass the conflict check and double-book a teacher.
 */
async function lockTimetable(tx: Tx, schoolId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${timetableLockKey(schoolId)}, 0))`;
}

/** Key of the per-school advisory lock every timetable change takes. */
export function timetableLockKey(schoolId: string): string {
  return `timetable:${schoolId}`;
}

async function inTransaction<T>(
  db: SchoolDb,
  fn: (tx: Tx, schoolId: string) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const school = await tx.school.findFirstOrThrow({ select: { id: true } });
    await lockTimetable(tx, school.id);
    return fn(tx, school.id);
  });
}

function assertKnown(context: SchedulingContext, slot: SlotChange) {
  const missing = (
    [
      ["group", slot.groupId, context.groups],
      ["teacher", slot.teacherId, context.teachers],
      ["room", slot.roomId, context.rooms],
    ] as const
  ).find(
    ([, id, list]) =>
      id && !list.some((item: { id: string }) => item.id === id),
  );
  if (missing) {
    throw new SchedulingError(
      "NOT_FOUND",
      `Unknown ${missing[0]} ${missing[1]}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Lesson sync
// ---------------------------------------------------------------------------

/** Generated lessons of `slotIds` (or the whole term) from `from` on, with dependents flagged. */
async function loadSyncLessons(
  tx: Tx,
  termId: string,
  from: IsoDate,
  slotIds?: string[],
): Promise<ExistingLesson[]> {
  const rows = await tx.lesson.findMany({
    where: {
      termId,
      timetableSlotId: slotIds ? { in: slotIds } : { not: null },
      occurrenceDate: { gte: fromIsoDate(from) },
    },
    select: {
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
      log: { select: { id: true } },
      _count: {
        select: {
          attendance: true,
          assignmentsSet: true,
          assignmentsDue: true,
          teacherNotes: true,
          absenceReports: true,
          replacementsFrom: true,
          replacementsTo: true,
          makeupCredits: true,
        },
      },
    },
  });
  return rows.map(({ log, _count, ...lesson }) => ({
    ...lesson,
    occurrenceDate: isoOrNull(lesson.occurrenceDate),
    hasDependents: log !== null || Object.values(_count).some((n) => n > 0),
  }));
}

async function applyPlan(
  tx: Tx,
  schoolId: string,
  termId: string,
  plan: LessonSyncPlan,
): Promise<LessonChanges> {
  if (plan.remove.length > 0) {
    await tx.lesson.deleteMany({
      where: { id: { in: plan.remove }, status: "SCHEDULED" },
    });
  }
  for (const reason of ["HOLIDAY", "TIMETABLE_CHANGED"] as const) {
    const ids = plan.cancel.filter((c) => c.reason === reason).map((c) => c.id);
    if (ids.length === 0) continue;
    await tx.lesson.updateMany({
      where: { id: { in: ids }, status: "SCHEDULED" },
      data: { status: "CANCELLED", cancelReason: reason },
    });
  }
  if (plan.create.length > 0) {
    await tx.lesson.createMany({
      data: plan.create.map((o) => ({
        schoolId,
        termId,
        timetableSlotId: o.timetableSlotId,
        occurrenceDate: fromIsoDate(o.date),
        groupId: o.groupId,
        teacherId: o.teacherId,
        roomId: o.roomId,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
      })),
      skipDuplicates: true,
    });
  }
  return {
    created: plan.create.length,
    removed: plan.remove.length,
    cancelled: plan.cancel.length,
  };
}

/** Reconciles lessons of `slots` (all of them belong to `loaded.term`) from `from` on. */
async function syncSlots(
  tx: Tx,
  loaded: Loaded,
  slots: SlotInfo[],
  from: IsoDate,
  now: Date,
  scope: "slots" | "term",
): Promise<LessonChanges> {
  const lessons = await loadSyncLessons(
    tx,
    loaded.term.id,
    from,
    scope === "slots" ? slots.map((s) => s.id) : undefined,
  );
  const plan = planLessonSync({
    term: loaded.term,
    slots,
    holidays: holidaysOfTerm(loaded.context.holidays, loaded.term.id),
    lessons,
    timeZone: loaded.context.school.timeZone,
    from,
    now,
  });
  return applyPlan(tx, loaded.schoolId, loaded.term.id, plan);
}

const addChanges = (a: LessonChanges, b: LessonChanges): LessonChanges => ({
  created: a.created + b.created,
  removed: a.removed + b.removed,
  cancelled: a.cancelled + b.cancelled,
});

const maxDate = (a: IsoDate, b: IsoDate) => (a > b ? a : b);

/** Conflict summary stored in the audit log. */
const auditConflicts = (conflicts: Conflict[]) =>
  conflicts.map((c) => ({
    type: c.type,
    key: c.key,
    severity: c.severity,
    dates: c.dates,
    params: c.params,
  }));

async function audit(
  tx: Tx,
  schoolId: string,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string,
  data: Record<string, unknown>,
) {
  await tx.auditLog.create({
    data: {
      schoolId,
      actorId: actor.userId,
      action,
      entityType,
      entityId,
      data: JSON.parse(JSON.stringify(data)),
    },
  });
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export type SlotInput = {
  termId: string;
  groupId: string;
  teacherId: string;
  roomId: string | null;
  weekday: number;
  startMinute: number;
  endMinute: number;
};

export type SlotRequest = {
  /** Set to edit an existing slot. */
  slotId?: string;
  slot: SlotInput;
  /**
   * First date the new or changed slot applies (published terms only;
   * default today). Lessons before it keep the old template.
   */
  effectiveFrom?: IsoDate;
};

/** Resolves a request into the slot as it would be stored, plus its effective start. */
async function resolveCandidate(
  loaded: Loaded,
  request: SlotRequest,
): Promise<{
  candidate: SlotInfo | Omit<SlotInfo, "id">;
  existing?: SlotInfo;
  effectiveFrom: IsoDate | null;
}> {
  const { context, term, today } = loaded;
  assertKnown(context, request.slot);
  const published = term.publishedAt !== null;
  if (request.effectiveFrom !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(request.effectiveFrom)) {
      throw new SchedulingError(
        "INVALID_INPUT",
        "effectiveFrom must be YYYY-MM-DD",
      );
    }
    if (published && request.effectiveFrom < today) {
      throw new SchedulingError(
        "EFFECTIVE_DATE_IN_PAST",
        "Changes to a published timetable cannot start in the past",
      );
    }
  }
  const effectiveFrom = request.effectiveFrom ?? (published ? today : null);

  if (!request.slotId) {
    return {
      candidate: {
        ...request.slot,
        validFrom: effectiveFrom
          ? maxDate(effectiveFrom, term.startDate)
          : null,
        validUntil: null,
      },
      effectiveFrom,
    };
  }

  const existing = context.slots.find((s) => s.id === request.slotId);
  if (!existing) {
    throw new SchedulingError("NOT_FOUND", `Slot ${request.slotId} not found`);
  }
  if (existing.termId !== request.slot.termId) {
    throw new SchedulingError(
      "INVALID_INPUT",
      "A slot cannot move to another term",
    );
  }
  // Draft terms have no lessons: the edit rewrites the whole slot. In a
  // published term it applies from the effective date (never before the
  // slot's own start), and earlier lessons keep the old template.
  const start = effectiveFrom
    ? maxDate(effectiveFrom, existing.validFrom ?? term.startDate)
    : existing.validFrom;
  return {
    candidate: { ...existing, ...request.slot, validFrom: start },
    existing,
    effectiveFrom: effectiveFrom ? start : null,
  };
}

/** Conflicts of a new or edited slot, for live display in the editor. */
export async function validateSlot(
  db: SchoolDb,
  request: SlotRequest,
  now = new Date(),
): Promise<Conflict[]> {
  return db.$transaction(async (tx) => {
    const loaded = await load(tx, request.slot.termId, now);
    const { candidate } = await resolveCandidate(loaded, request);
    return checkSlot(buildCalendar(loaded.context), candidate);
  });
}

export type SaveSlotResult =
  | {
      ok: true;
      slotId: string;
      /** The slot that was ended when an edit had to split it. */
      endedSlotId?: string;
      overridden: Conflict[];
      lessons: LessonChanges;
    }
  | {
      ok: false;
      reason: "BLOCKING_CONFLICTS" | "UNACKNOWLEDGED_CONFLICTS";
      conflicts: Conflict[];
    };

/**
 * Creates or edits a slot. Saves only if there is no blocking conflict and
 * every overridable one is in `acknowledgedConflictKeys` (the admin's
 * override, recorded in the audit log). In a published term, lessons from
 * `effectiveFrom` on follow the change; see docs/architecture/scheduling.md.
 */
export async function saveSlot(
  db: SchoolDb,
  actor: Actor,
  request: SlotRequest & {
    acknowledgedConflictKeys?: string[];
    /** The admin's optional reason for overriding warnings (audited). */
    reason?: string;
  },
  now = new Date(),
): Promise<SaveSlotResult> {
  return inTransaction(db, async (tx, schoolId) => {
    const loaded = await load(tx, request.slot.termId, now);
    const { candidate, existing, effectiveFrom } = await resolveCandidate(
      loaded,
      request,
    );
    const conflicts = checkSlot(buildCalendar(loaded.context), candidate);
    const decision = decideSave(
      conflicts,
      request.acknowledgedConflictKeys ?? [],
    );
    if (!decision.ok) return { ok: false, reason: decision.reason, conflicts };

    const published = loaded.term.publishedAt !== null;
    const data = {
      ...request.slot,
      validFrom: candidate.validFrom ? fromIsoDate(candidate.validFrom) : null,
      validUntil: candidate.validUntil
        ? fromIsoDate(candidate.validUntil)
        : null,
    };
    const auditData = {
      slot: request.slot,
      effectiveFrom,
      overridden: auditConflicts(decision.overridden),
      ...(request.reason && { reason: request.reason }),
    };

    if (!existing) {
      const created = await tx.timetableSlot.create({
        data: { ...data, schoolId },
        select: { id: true },
      });
      const lessons = published
        ? await syncSlots(
            tx,
            loaded,
            [{ ...candidate, id: created.id }],
            loaded.today,
            now,
            "slots",
          )
        : { created: 0, removed: 0, cancelled: 0 };
      await audit(
        tx,
        schoolId,
        actor,
        "timetable_slot.created",
        "TimetableSlot",
        created.id,
        { ...auditData, lessons },
      );
      return {
        ok: true,
        slotId: created.id,
        overridden: decision.overridden,
        lessons,
      };
    }

    // 1. Lessons of the old template from the effective date on go away
    //    (deleted, or cancelled when they carry history).
    let lessons: LessonChanges = { created: 0, removed: 0, cancelled: 0 };
    const from = effectiveFrom ?? loaded.term.startDate;
    if (effectiveFrom) {
      const ending = {
        ...existing,
        validUntil: addDays(candidate.validFrom ?? from, -1),
      };
      lessons = await syncSlots(
        tx,
        loaded,
        [ending],
        maxDate(from, loaded.today),
        now,
        "slots",
      );
    }
    // 2. Rewrite the slot if no lesson refers to it any more, else split it.
    const remaining = await tx.lesson.count({
      where: { timetableSlotId: existing.id },
    });
    const change: SlotChange = {
      groupId: request.slot.groupId,
      teacherId: request.slot.teacherId,
      roomId: request.slot.roomId,
      weekday: request.slot.weekday,
      startMinute: request.slot.startMinute,
      endMinute: request.slot.endMinute,
    };
    const edit = planSlotEdit(existing, change, effectiveFrom, remaining);
    let result: SlotInfo;
    let endedSlotId: string | undefined;
    if (edit.kind === "update") {
      result = edit.slot;
      await tx.timetableSlot.update({
        where: { id: existing.id },
        data: {
          ...change,
          validFrom: result.validFrom ? fromIsoDate(result.validFrom) : null,
        },
      });
    } else {
      endedSlotId = existing.id;
      await tx.timetableSlot.update({
        where: { id: existing.id },
        data: { validUntil: fromIsoDate(edit.ended.validUntil!) },
      });
      const next = await tx.timetableSlot.create({
        data: {
          ...edit.next,
          schoolId,
          validFrom: edit.next.validFrom
            ? fromIsoDate(edit.next.validFrom)
            : null,
          validUntil: edit.next.validUntil
            ? fromIsoDate(edit.next.validUntil)
            : null,
        },
        select: { id: true },
      });
      result = { ...edit.next, id: next.id };
    }
    // 3. Lessons of the new template.
    if (published) {
      lessons = addChanges(
        lessons,
        await syncSlots(
          tx,
          loaded,
          [result],
          maxDate(from, loaded.today),
          now,
          "slots",
        ),
      );
    }
    await audit(
      tx,
      schoolId,
      actor,
      "timetable_slot.updated",
      "TimetableSlot",
      existing.id,
      {
        ...auditData,
        mode: edit.kind,
        newSlotId: edit.kind === "split" ? result.id : undefined,
        lessons,
      },
    );
    return {
      ok: true,
      slotId: result.id,
      endedSlotId,
      overridden: decision.overridden,
      lessons,
    };
  });
}

export type EndSlotResult = {
  /** `deleted` when the slot never took effect and nothing refers to it. */
  outcome: "ended" | "deleted";
  lessons: LessonChanges;
};

/**
 * Ends a slot after `lastDate` (default today): past lessons stay, later
 * SCHEDULED ones are deleted, or cancelled when they carry history. A slot
 * ended before it ever took effect, with no lessons left, is deleted.
 */
export async function endSlot(
  db: SchoolDb,
  actor: Actor,
  { slotId, lastDate }: { slotId: string; lastDate?: IsoDate },
  now = new Date(),
): Promise<EndSlotResult> {
  return inTransaction(db, async (tx, schoolId) => {
    const row = await tx.timetableSlot.findUnique({ where: { id: slotId } });
    if (!row)
      throw new SchedulingError("NOT_FOUND", `Slot ${slotId} not found`);
    const loaded = await load(tx, row.termId, now);
    const slot = toSlotInfo(row);
    const last = lastDate ?? loaded.today;
    if (loaded.term.publishedAt && last < addDays(loaded.today, -1)) {
      throw new SchedulingError(
        "EFFECTIVE_DATE_IN_PAST",
        "A slot of a published timetable cannot end before yesterday",
      );
    }
    const validUntil =
      slot.validUntil && slot.validUntil < last ? slot.validUntil : last;
    const ended = { ...slot, validUntil };
    const lessons = await syncSlots(
      tx,
      loaded,
      [ended],
      maxDate(addDays(validUntil, 1), loaded.today),
      now,
      "slots",
    );
    const start = slot.validFrom ?? loaded.term.startDate;
    const remaining = await tx.lesson.count({
      where: { timetableSlotId: slotId },
    });
    const outcome = validUntil < start && remaining === 0 ? "deleted" : "ended";
    if (outcome === "deleted") {
      await tx.timetableSlot.delete({ where: { id: slotId } });
    } else {
      await tx.timetableSlot.update({
        where: { id: slotId },
        data: { validUntil: fromIsoDate(validUntil) },
      });
    }
    await audit(
      tx,
      schoolId,
      actor,
      `timetable_slot.${outcome}`,
      "TimetableSlot",
      slotId,
      {
        lastDate: validUntil,
        lessons,
      },
    );
    return { outcome, lessons };
  });
}

/**
 * Deletes a slot that has no lessons with history (typically in a draft
 * term). Otherwise throws `SLOT_HAS_LESSONS`: end the slot instead.
 */
export async function deleteSlot(
  db: SchoolDb,
  actor: Actor,
  slotId: string,
  now = new Date(),
): Promise<LessonChanges> {
  return inTransaction(db, async (tx, schoolId) => {
    const row = await tx.timetableSlot.findUnique({ where: { id: slotId } });
    if (!row)
      throw new SchedulingError("NOT_FOUND", `Slot ${slotId} not found`);
    const loaded = await load(tx, row.termId, now);
    const slot = toSlotInfo(row);
    const gone = { ...slot, validUntil: addDays(loaded.term.startDate, -1) };
    const lessons = await syncSlots(
      tx,
      loaded,
      [gone],
      loaded.term.startDate,
      now,
      "slots",
    );
    const remaining = await tx.lesson.count({
      where: { timetableSlotId: slotId },
    });
    if (remaining > 0) {
      throw new SchedulingError(
        "SLOT_HAS_LESSONS",
        `Slot ${slotId} has ${remaining} lessons that must be kept; end it instead`,
      );
    }
    await tx.timetableSlot.delete({ where: { id: slotId } });
    await audit(
      tx,
      schoolId,
      actor,
      "timetable_slot.deleted",
      "TimetableSlot",
      slotId,
      {
        slot,
        lessons,
      },
    );
    return lessons;
  });
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

/**
 * Conflicts of a single lesson change (move, room change, substitute,
 * ad-hoc lesson). Saving lesson edits arrives with Phases 2–5; they must
 * check through this first.
 */
export async function validateLesson(
  db: SchoolDb,
  candidate: LessonCandidate,
  now = new Date(),
): Promise<Conflict[]> {
  return db.$transaction(async (tx) => {
    const loaded = await load(tx, candidate.termId, now);
    return checkLesson(buildCalendar(loaded.context), candidate);
  });
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

/** Conflicts of every slot of a term, keyed by slot id, for the editor's overview. */
export async function checkTerm(
  db: SchoolDb,
  termId: string,
  now = new Date(),
): Promise<Map<string, Conflict[]>> {
  return db.$transaction(async (tx) => {
    const loaded = await load(tx, termId, now);
    return checkTimetable(buildCalendar(loaded.context), termId);
  });
}

export type PublishResult =
  | { ok: true; lessons: LessonChanges; warnings: number }
  | { ok: false; blocking: { slotId: string; conflicts: Conflict[] }[] };

/**
 * Publishes a term's timetable and generates its lessons from today (or the
 * term start, if later). Refused while any slot has a blocking conflict.
 * Publishing again just regenerates.
 */
export async function publishTerm(
  db: SchoolDb,
  actor: Actor,
  termId: string,
  now = new Date(),
): Promise<PublishResult> {
  return inTransaction(db, async (tx, schoolId) => {
    const loaded = await load(tx, termId, now);
    const all = checkTimetable(buildCalendar(loaded.context), termId);
    const blocking = [...all]
      .map(([slotId, conflicts]) => ({
        slotId,
        conflicts: conflicts.filter((c) => c.severity === "blocking"),
      }))
      .filter((entry) => entry.conflicts.length > 0);
    if (blocking.length > 0) return { ok: false, blocking };

    const warnings = [...all.values()].reduce((n, list) => n + list.length, 0);
    if (!loaded.term.publishedAt) {
      await tx.term.update({
        where: { id: termId },
        data: { timetablePublishedAt: now },
      });
    }
    const slots = loaded.context.slots.filter((s) => s.termId === termId);
    const lessons = await syncSlots(
      tx,
      loaded,
      slots,
      maxDate(loaded.term.startDate, loaded.today),
      now,
      "term",
    );
    await audit(tx, schoolId, actor, "timetable.published", "Term", termId, {
      slots: slots.length,
      warnings,
      lessons,
    });
    return { ok: true, lessons, warnings };
  });
}

async function regenerateIn(
  tx: Tx,
  schoolId: string,
  actor: Actor,
  termId: string,
  now: Date,
  cause: string,
): Promise<LessonChanges> {
  const loaded = await load(tx, termId, now);
  if (!loaded.term.publishedAt) {
    throw new SchedulingError(
      "NOT_PUBLISHED",
      `Term ${termId} is not published`,
    );
  }
  const slots = loaded.context.slots.filter((s) => s.termId === termId);
  const lessons = await syncSlots(
    tx,
    loaded,
    slots,
    maxDate(loaded.term.startDate, loaded.today),
    now,
    "term",
  );
  await audit(tx, schoolId, actor, "lessons.regenerated", "Term", termId, {
    cause,
    lessons,
  });
  return lessons;
}

/**
 * Brings a published term's lessons from today on in line with its slots and
 * holidays. Idempotent. Call it after changing a published term's dates.
 */
export async function regenerateLessons(
  db: SchoolDb,
  actor: Actor,
  termId: string,
  now = new Date(),
): Promise<LessonChanges> {
  return inTransaction(db, (tx, schoolId) =>
    regenerateIn(tx, schoolId, actor, termId, now, "manual"),
  );
}

/**
 * Deletes a term with its slots and its own holidays. Only possible while it
 * has no lessons (i.e. before publishing); lessons carry history.
 */
export async function deleteTerm(
  db: SchoolDb,
  actor: Actor,
  termId: string,
): Promise<void> {
  await inTransaction(db, async (tx, schoolId) => {
    const term = await tx.term.findUnique({ where: { id: termId } });
    if (!term)
      throw new SchedulingError("NOT_FOUND", `Term ${termId} not found`);
    const lessons = await tx.lesson.count({ where: { termId } });
    if (lessons > 0) {
      throw new SchedulingError(
        "TERM_HAS_LESSONS",
        `Term ${termId} has ${lessons} lessons and cannot be deleted`,
      );
    }
    await tx.term.delete({ where: { id: termId } });
    await audit(tx, schoolId, actor, "term.deleted", "Term", termId, {
      name: term.name,
    });
  });
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export type HolidayInput = {
  /** Null = school-wide. */
  termId: string | null;
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
};

/** Published terms a holiday change affects. */
async function affectedTerms(
  tx: Tx,
  ranges: { termId: string | null; startDate: Date; endDate: Date }[],
): Promise<string[]> {
  const ids = new Set<string>();
  for (const range of ranges) {
    const terms = await tx.term.findMany({
      where: {
        timetablePublishedAt: { not: null },
        ...(range.termId
          ? { id: range.termId }
          : {
              startDate: { lte: range.endDate },
              endDate: { gte: range.startDate },
            }),
      },
      select: { id: true },
    });
    for (const t of terms) ids.add(t.id);
  }
  return [...ids].sort();
}

async function resync(
  tx: Tx,
  schoolId: string,
  actor: Actor,
  termIds: string[],
  now: Date,
  cause: string,
): Promise<LessonChanges> {
  let total: LessonChanges = { created: 0, removed: 0, cancelled: 0 };
  for (const termId of termIds) {
    total = addChanges(
      total,
      await regenerateIn(tx, schoolId, actor, termId, now, cause),
    );
  }
  return total;
}

/**
 * Creates or updates a holiday. Lessons of affected published terms from
 * today on follow: removed (or cancelled with reason HOLIDAY when they carry
 * history) on new holiday days, restored on days that are no longer holidays.
 */
export async function saveHoliday(
  db: SchoolDb,
  actor: Actor,
  { holidayId, holiday }: { holidayId?: string; holiday: HolidayInput },
  now = new Date(),
): Promise<{ holidayId: string; lessons: LessonChanges }> {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(holiday.startDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(holiday.endDate) ||
    holiday.startDate > holiday.endDate
  ) {
    throw new SchedulingError("INVALID_INPUT", "Holiday dates are invalid");
  }
  return inTransaction(db, async (tx, schoolId) => {
    if (
      holiday.termId &&
      !(await tx.term.findUnique({ where: { id: holiday.termId } }))
    ) {
      throw new SchedulingError(
        "NOT_FOUND",
        `Term ${holiday.termId} not found`,
      );
    }
    const data = {
      termId: holiday.termId,
      name: holiday.name,
      startDate: fromIsoDate(holiday.startDate),
      endDate: fromIsoDate(holiday.endDate),
    };
    const before = holidayId
      ? await tx.holiday.findUnique({ where: { id: holidayId } })
      : null;
    if (holidayId && !before) {
      throw new SchedulingError("NOT_FOUND", `Holiday ${holidayId} not found`);
    }
    const saved = holidayId
      ? await tx.holiday.update({ where: { id: holidayId }, data })
      : await tx.holiday.create({ data: { ...data, schoolId } });
    const terms = await affectedTerms(tx, before ? [before, saved] : [saved]);
    const lessons = await resync(
      tx,
      schoolId,
      actor,
      terms,
      now,
      `holiday:${saved.id}`,
    );
    await audit(
      tx,
      schoolId,
      actor,
      holidayId ? "holiday.updated" : "holiday.created",
      "Holiday",
      saved.id,
      {
        holiday,
        lessons,
      },
    );
    return { holidayId: saved.id, lessons };
  });
}

/** Deletes a holiday; affected published terms get their lessons back from today on. */
export async function deleteHoliday(
  db: SchoolDb,
  actor: Actor,
  holidayId: string,
  now = new Date(),
): Promise<LessonChanges> {
  return inTransaction(db, async (tx, schoolId) => {
    const holiday = await tx.holiday.findUnique({ where: { id: holidayId } });
    if (!holiday)
      throw new SchedulingError("NOT_FOUND", `Holiday ${holidayId} not found`);
    await tx.holiday.delete({ where: { id: holidayId } });
    const terms = await affectedTerms(tx, [holiday]);
    const lessons = await resync(
      tx,
      schoolId,
      actor,
      terms,
      now,
      `holiday:${holidayId}`,
    );
    await audit(tx, schoolId, actor, "holiday.deleted", "Holiday", holidayId, {
      name: holiday.name,
      lessons,
    });
    return lessons;
  });
}
