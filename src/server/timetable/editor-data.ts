// Loads everything the admin timetable editor renders for one term
// (docs/design/timetable.md §5). Callers check `requireRole("ADMIN")` first
// and pass the school-scoped client.

import {
  type Conflict,
  holidaysOfTerm,
  type IsoDate,
  toIsoDate,
} from "@/server/scheduling";

import {
  acknowledgementsFromAudit,
  type Acknowledgement,
  clampToTerm,
  defaultAsOf,
  pickTerm,
  showChangedOn,
  splitDatesFromAudit,
  type TermSummary,
} from "./editor";
import { checkTerm, type SchoolDb } from "./service";

export type EditorSlot = {
  id: string;
  groupId: string;
  groupName: string;
  groupType: "GROUP" | "ONE_ON_ONE";
  level: string;
  teacherId: string;
  teacherName: string;
  roomId: string | null;
  weekday: number;
  startMinute: number;
  endMinute: number;
  validFrom: IsoDate | null;
  validUntil: IsoDate | null;
  /** Some lesson of it already started: offer End, not Delete (§5.5). */
  tookPlace: boolean;
  /** Effective date of the edit that created this slot by a split, while recent. */
  changedOn: IsoDate | null;
};

export type EditorRoom = {
  id: string;
  name: string;
  online: boolean;
  capacity: number | null;
  archived: boolean;
};

export type EditorOption = {
  id: string;
  name: string;
  archived: boolean;
};

export type EditorGroupOption = EditorOption & {
  type: "GROUP" | "ONE_ON_ONE";
  level: string;
  members: number;
};

export type EditorData = {
  terms: TermSummary[];
  term: TermSummary | null;
  asOf: IsoDate | null;
  today: IsoDate;
  school: {
    teachingWeekdays: number[];
    dayStartMinute: number;
    dayEndMinute: number;
  };
  /** Every slot of the term (the client filters by "As of"). */
  slots: EditorSlot[];
  issues: Record<string, Conflict[]>;
  acknowledgements: Record<string, Acknowledgement>;
  holidays: { name: string; startDate: IsoDate; endDate: IsoDate }[];
  rooms: EditorRoom[];
  teachers: EditorOption[];
  groups: EditorGroupOption[];
  /** Teachers' weekly unavailability, for the hatched background (§5.2). */
  unavailability: {
    teacherId: string;
    weekday: number;
    startMinute: number;
    endMinute: number;
  }[];
};

export async function loadEditor(
  db: SchoolDb,
  {
    termParam,
    asOfParam,
    today,
    now = new Date(),
  }: {
    termParam?: string;
    asOfParam?: IsoDate;
    today: IsoDate;
    now?: Date;
  },
): Promise<EditorData> {
  const [school, termRows, roomRows, teacherRows, groupRows, rules] =
    await Promise.all([
      db.school.findFirstOrThrow({
        select: {
          teachingWeekdays: true,
          dayStartMinute: true,
          dayEndMinute: true,
        },
      }),
      db.term.findMany({
        select: {
          id: true,
          name: true,
          startDate: true,
          endDate: true,
          timetablePublishedAt: true,
        },
        orderBy: { startDate: "desc" },
      }),
      db.room.findMany({
        select: {
          id: true,
          name: true,
          kind: true,
          capacity: true,
          archivedAt: true,
        },
      }),
      db.teacherProfile.findMany({
        select: { id: true, user: { select: { name: true, deletedAt: true } } },
        orderBy: { user: { name: "asc" } },
      }),
      db.group.findMany({
        select: {
          id: true,
          name: true,
          type: true,
          deletedAt: true,
          level: { select: { code: true } },
          _count: { select: { memberships: { where: { leftAt: null } } } },
        },
        orderBy: { name: "asc" },
      }),
      db.teacherAvailability.findMany({
        where: { kind: "WEEKLY_UNAVAILABLE" },
        select: {
          teacherId: true,
          weekday: true,
          startMinute: true,
          endMinute: true,
        },
      }),
    ]);

  const terms: TermSummary[] = termRows.map((t) => ({
    id: t.id,
    name: t.name,
    startDate: toIsoDate(t.startDate),
    endDate: toIsoDate(t.endDate),
    publishedAt: t.timetablePublishedAt?.toISOString() ?? null,
  }));
  const term = pickTerm(terms, termParam, today);

  // Physical rooms first, then online; by name (§5.2).
  const rooms: EditorRoom[] = roomRows
    .map((r) => ({
      id: r.id,
      name: r.name,
      online: r.kind === "ONLINE",
      capacity: r.capacity,
      archived: r.archivedAt !== null,
    }))
    .sort(
      (a, b) =>
        Number(a.online) - Number(b.online) || a.name.localeCompare(b.name),
    );
  const teachers = teacherRows.map((t) => ({
    id: t.id,
    name: t.user.name,
    archived: t.user.deletedAt !== null,
  }));
  const groups = groupRows.map((g) => ({
    id: g.id,
    name: g.name,
    archived: g.deletedAt !== null,
    type: g.type,
    level: g.level.code,
    members: g._count.memberships,
  }));
  const unavailability = rules.flatMap((r) =>
    r.weekday !== null && r.startMinute !== null && r.endMinute !== null
      ? [
          {
            teacherId: r.teacherId,
            weekday: r.weekday,
            startMinute: r.startMinute,
            endMinute: r.endMinute,
          },
        ]
      : r.weekday !== null
        ? [
            {
              teacherId: r.teacherId,
              weekday: r.weekday,
              startMinute: 0,
              endMinute: 24 * 60,
            },
          ]
        : [],
  );

  const base = {
    terms,
    today,
    school,
    rooms,
    teachers,
    groups,
    unavailability,
  };
  if (!term) {
    return {
      ...base,
      term: null,
      asOf: null,
      slots: [],
      issues: {},
      acknowledgements: {},
      holidays: [],
    };
  }

  const [slotRows, holidayRows, pastLessons] = await Promise.all([
    db.timetableSlot.findMany({
      where: { termId: term.id },
      select: {
        id: true,
        groupId: true,
        teacherId: true,
        roomId: true,
        weekday: true,
        startMinute: true,
        endMinute: true,
        validFrom: true,
        validUntil: true,
        group: {
          select: { name: true, type: true, level: { select: { code: true } } },
        },
        teacher: { select: { user: { select: { name: true } } } },
      },
      orderBy: [{ weekday: "asc" }, { startMinute: "asc" }, { id: "asc" }],
    }),
    db.holiday.findMany({
      where: { OR: [{ termId: term.id }, { termId: null }] },
      select: {
        id: true,
        name: true,
        termId: true,
        startDate: true,
        endDate: true,
      },
    }),
    db.lesson.groupBy({
      by: ["timetableSlotId"],
      where: { termId: term.id, startsAt: { lt: now } },
      _count: { _all: true },
    }),
  ]);
  const slotIds = slotRows.map((s) => s.id);
  const auditRows = slotIds.length
    ? await db.auditLog.findMany({
        where: {
          entityType: "TimetableSlot",
          entityId: { in: slotIds },
          action: { in: ["timetable_slot.created", "timetable_slot.updated"] },
        },
        select: {
          entityId: true,
          action: true,
          createdAt: true,
          data: true,
          actor: { select: { name: true } },
        },
      })
    : [];
  const audit = auditRows.map((a) => ({
    ...a,
    actorName: a.actor?.name ?? "",
  }));
  const acks = acknowledgementsFromAudit(audit);
  const splits = splitDatesFromAudit(audit);
  const tookPlace = new Set(
    pastLessons.map((l) => l.timetableSlotId).filter(Boolean),
  );

  const slots: EditorSlot[] = slotRows.map((s) => {
    const changed = splits.get(s.id);
    return {
      id: s.id,
      groupId: s.groupId,
      groupName: s.group.name,
      groupType: s.group.type,
      level: s.group.level.code,
      teacherId: s.teacherId,
      teacherName: s.teacher.user.name,
      roomId: s.roomId,
      weekday: s.weekday,
      startMinute: s.startMinute,
      endMinute: s.endMinute,
      validFrom: s.validFrom ? toIsoDate(s.validFrom) : null,
      validUntil: s.validUntil ? toIsoDate(s.validUntil) : null,
      tookPlace: tookPlace.has(s.id),
      changedOn: changed && showChangedOn(changed, today) ? changed : null,
    };
  });

  const issueMap = await checkTerm(db, term.id, now);
  const holidays = holidaysOfTerm(
    holidayRows.map((h) => ({
      id: h.id,
      name: h.name,
      termId: h.termId,
      startDate: toIsoDate(h.startDate),
      endDate: toIsoDate(h.endDate),
    })),
    term.id,
  ).map(({ name, startDate, endDate }) => ({ name, startDate, endDate }));

  return {
    ...base,
    term,
    asOf: clampToTerm(asOfParam ?? defaultAsOf(term, today), term),
    slots,
    issues: Object.fromEntries(issueMap),
    acknowledgements: Object.fromEntries(acks),
    holidays,
  };
}
