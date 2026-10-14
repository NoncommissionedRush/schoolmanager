// Loads the "Assign teachers" page (docs/design/timetable-generator.md §6)
// for one term. Callers check `requireRole("ADMIN")` first and pass the
// school-scoped client; everything returned is plain, serialisable data.

import type { Readiness } from "@/server/scheduling/generator";
import { type IsoDate, toIsoDate } from "@/server/scheduling";

import { pickTerm, type TermSummary } from "./editor";
import {
  checkReadiness,
  defaultEffectiveDate,
  type DraftView,
  getDraft,
} from "./generator-service";
import type { SchoolDb } from "./service";

export type GeneratorGroupInfo = {
  id: string;
  name: string;
  type: "GROUP" | "ONE_ON_ONE";
  levelId: string;
  members: number;
  lessonTimes: {
    weekday: number;
    startMinute: number;
    endMinute: number;
    roomId: string;
  }[];
};

export type GeneratorTeacherInfo = {
  id: string;
  name: string;
  color: string | null;
  archived: boolean;
  levelIds: string[];
  maxMinutesPerWeek: number | null;
};

export type GeneratorPageData = {
  today: IsoDate;
  terms: TermSummary[];
  term: TermSummary | null;
  /** The term's last day is before today: read-only (§8). */
  termEnded: boolean;
  /** _D_ offered by the Assign dialog of a published term. */
  defaultEffectiveFrom: IsoDate;
  /** Slots of the term in the editor (REPLACE: "Keep current teachers"). */
  termSlotCount: number;
  readiness: Readiness | null;
  draft: DraftView | null;
  /** Name of the admin who started the draft's latest run. */
  latestRunBy: string | null;
  groups: GeneratorGroupInfo[];
  teachers: GeneratorTeacherInfo[];
  /** In rank order. */
  levels: { id: string; code: string; name: string }[];
  rooms: { id: string; name: string; online: boolean }[];
};

export async function loadGeneratorPage(
  db: SchoolDb,
  {
    termParam,
    today,
  }: {
    termParam?: string;
    today: IsoDate;
  },
): Promise<GeneratorPageData> {
  const [termRows, groupRows, teacherRows, levelRows, roomRows] =
    await Promise.all([
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
      db.group.findMany({
        where: { deletedAt: null },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          type: true,
          levelId: true,
          lessonTimes: {
            orderBy: [{ weekday: "asc" }, { startMinute: "asc" }],
            select: {
              weekday: true,
              startMinute: true,
              endMinute: true,
              roomId: true,
            },
          },
          _count: { select: { memberships: { where: { leftAt: null } } } },
        },
      }),
      db.teacherProfile.findMany({
        orderBy: { user: { name: "asc" } },
        select: {
          id: true,
          color: true,
          maxMinutesPerWeek: true,
          user: { select: { name: true, deletedAt: true } },
          levels: { select: { levelId: true } },
        },
      }),
      db.level.findMany({
        orderBy: { rank: "asc" },
        select: { id: true, code: true, name: true },
      }),
      db.room.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true, kind: true },
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
  const [readiness, draft, termSlotCount] = term
    ? await Promise.all([
        checkReadiness(db, term.id),
        getDraft(db, term.id),
        db.timetableSlot.count({ where: { termId: term.id } }),
      ])
    : [null, null, 0];
  const startedById = draft?.latestRun?.startedById;
  const latestRunBy = startedById
    ? ((
        await db.user.findFirst({
          where: { id: startedById },
          select: { name: true },
        })
      )?.name ?? null)
    : null;

  let defaultFrom = defaultEffectiveDate(today);
  if (term && defaultFrom < term.startDate) defaultFrom = term.startDate;

  return {
    today,
    terms,
    term,
    termEnded: term !== null && term.endDate < today,
    defaultEffectiveFrom: defaultFrom,
    termSlotCount,
    readiness,
    draft,
    latestRunBy,
    groups: groupRows.map((g) => ({
      id: g.id,
      name: g.name,
      type: g.type,
      levelId: g.levelId,
      members: g._count.memberships,
      lessonTimes: g.lessonTimes,
    })),
    teachers: teacherRows.map((t) => ({
      id: t.id,
      name: t.user.name,
      color: t.color,
      archived: t.user.deletedAt !== null,
      levelIds: t.levels.map((l) => l.levelId),
      maxMinutesPerWeek: t.maxMinutesPerWeek,
    })),
    levels: levelRows,
    rooms: roomRows.map((r) => ({
      id: r.id,
      name: r.name,
      online: r.kind === "ONLINE",
    })),
  };
}
