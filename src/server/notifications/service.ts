// Notifications: the database service (docs/architecture/phase5-rules.md
// §2). `notify` stores the notifications of a change inside the caller's
// transaction, so a rolled-back action notifies nobody and a committed one
// always has its notifications; the inbox functions read and mark the
// viewer's own rows. Callers pass the school-scoped client and one `now`.

import type { Prisma } from "@/generated/prisma/client";
import { ACTIVE_REPLACEMENT } from "@/server/replacements/release";
import type { Tx } from "@/server/timetable/service";
import { membersAt } from "@/server/timetable/week";

import { registeredChannels } from "./channels";
import {
  type Audience,
  coalesce,
  dedupeDrafts,
  type LessonFacts,
  type NotificationDraft,
  type NotificationEvent,
  type NotificationLink,
  type NotificationParams,
  recipientsFor,
  retentionCutoff,
  supersededBy,
} from "./rules";

/** The action a notification comes from. */
export type NotifySource = {
  /** The action's audit log id; `sourceKey` = `<sourceId>:<type>:<subject>`. */
  sourceId: string;
  /** The user who acted; never notified (§2.1). Null for system changes. */
  actorId: string | null;
};

/**
 * Stores the notifications of `events` (§2.5): drafts per recipient minus
 * the actor, de-duplicated in memory, then each one coalesced into the
 * recipient's unread row with the same `coalesceKey` or inserted. Recipients
 * must be signed-up members of this school (deleted users are skipped).
 * Returns the number of rows written or updated.
 */
export async function notify(
  tx: Tx,
  source: NotifySource,
  events: readonly NotificationEvent[],
  now: Date,
): Promise<number> {
  if (events.length === 0) return 0;
  const school = await tx.school.findFirstOrThrow({
    select: { id: true, timezone: true },
  });
  const drafts = dedupeDrafts(
    events.flatMap((event) =>
      recipientsFor(event, {
        actorId: source.actorId,
        now,
        timeZone: school.timezone,
      }),
    ),
  );
  if (drafts.length === 0) return 0;
  const active = await activeMembers(tx, [
    ...new Set(drafts.map((d) => d.recipientId)),
  ]);
  let written = 0;
  for (const draft of drafts) {
    if (!active.has(draft.recipientId)) continue;
    written += await store(tx, school.id, source, draft, now);
  }
  return written;
}

/** `User.id`s among `ids` with a membership in this school, not deleted. */
async function activeMembers(tx: Tx, ids: string[]): Promise<Set<string>> {
  const rows = await tx.membership.findMany({
    where: { userId: { in: ids }, user: { deletedAt: null } },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function store(
  tx: Tx,
  schoolId: string,
  source: NotifySource,
  draft: NotificationDraft,
  now: Date,
): Promise<number> {
  const sourceKey = `${source.sourceId}:${draft.type}:${draft.subject}`;
  const recipientId = draft.recipientId;

  const superseded = supersededBy(draft);
  if (superseded.length > 0) {
    await tx.notification.deleteMany({
      where: { recipientId, readAt: null, coalesceKey: { in: superseded } },
    });
  }

  if (draft.coalesceKey) {
    // An expired row that wasn't purged yet must not absorb the new event
    // (it would bring back old counts and dates): it goes first (CARM-63 QA).
    await tx.notification.deleteMany({
      where: {
        recipientId,
        coalesceKey: draft.coalesceKey,
        createdAt: { lte: retentionCutoff(now) },
      },
    });
    const existing = await tx.notification.findFirst({
      where: { recipientId, coalesceKey: draft.coalesceKey, readAt: null },
      select: {
        id: true,
        type: true,
        audience: true,
        params: true,
        link: true,
      },
    });
    if (existing) {
      const merged = coalesce(
        {
          type: existing.type,
          audience: existing.audience as Audience,
          params: existing.params as NotificationParams,
          link: existing.link as NotificationLink | null,
        },
        draft,
        recipientId,
      );
      if (!merged) {
        await tx.notification.deleteMany({
          where: { id: existing.id, readAt: null },
        });
        return 1;
      }
      // Conditional: a row read meanwhile is never changed (§2.5).
      const updated = await tx.notification.updateMany({
        where: { id: existing.id, readAt: null },
        data: {
          type: merged.type,
          audience: merged.audience,
          params: json(merged.params),
          link: merged.link ? json(merged.link) : undefined,
          sourceKey,
          actorId: source.actorId,
          createdAt: now,
        },
      });
      if (updated.count === 1) return 1;
    }
  }

  const created = await tx.notification.createManyAndReturn({
    data: [
      {
        schoolId,
        recipientId,
        type: draft.type,
        audience: draft.audience,
        params: json(draft.params),
        link: draft.link ? json(draft.link) : undefined,
        sourceKey,
        coalesceKey: draft.coalesceKey,
        actorId: source.actorId,
        createdAt: now,
      },
    ],
    // The unique `(school, recipient, sourceKey)` index is the backstop for
    // a duplicate inside one action (§2.5).
    skipDuplicates: true,
    select: { id: true, schoolId: true },
  });
  for (const row of created) await enqueueDeliveries(tx, row, draft);
  return created.length;
}

/** Outbox rows for the registered out-of-app channels (§2.6); none in v1. */
async function enqueueDeliveries(
  tx: Tx,
  row: { id: string; schoolId: string },
  draft: NotificationDraft,
) {
  for (const channel of registeredChannels()) {
    const stored = { ...row, ...draft };
    if (!channel.wants(stored, { userId: draft.recipientId })) continue;
    await tx.notificationDelivery.create({
      data: {
        schoolId: row.schoolId,
        notificationId: row.id,
        channel: channel.id,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Facts the rules need
// ---------------------------------------------------------------------------

// A function, not a constant: `release.ts` notifies through this module,
// so `ACTIVE_REPLACEMENT` may not be initialised yet when this one loads.
const lessonFactsSelect = () =>
  ({
    id: true,
    startsAt: true,
    endsAt: true,
    room: { select: { name: true } },
    group: {
      select: {
        name: true,
        type: true,
        memberships: {
          select: {
            joinedAt: true,
            leftAt: true,
            student: { select: { userId: true } },
          },
        },
      },
    },
    teacher: { select: { userId: true, user: { select: { name: true } } } },
    substituteTeacher: {
      select: { userId: true, user: { select: { name: true } } },
    },
    absenceReports: { select: { student: { select: { userId: true } } } },
    replacementsTo: {
      where: { status: { in: [...ACTIVE_REPLACEMENT] } },
      select: { student: { select: { userId: true } } },
    },
  }) satisfies Prisma.LessonSelect;

type LessonFactsRow = Prisma.LessonGetPayload<{
  select: ReturnType<typeof lessonFactsSelect>;
}>;

function toFacts(row: LessonFactsRow): LessonFacts {
  const absent = new Set(row.absenceReports.map((a) => a.student.userId));
  const members = membersAt(row.group.memberships, row.startsAt)
    .map((m) => m.student.userId)
    .filter((id) => !absent.has(id));
  return {
    id: row.id,
    groupName: row.group.name,
    lessonType: row.group.type,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    room: row.room?.name ?? null,
    teacher: { userId: row.teacher.userId, name: row.teacher.user.name },
    substitute: row.substituteTeacher
      ? {
          userId: row.substituteTeacher.userId,
          name: row.substituteTeacher.user.name,
        }
      : null,
    attendees: [
      ...new Set([
        ...members,
        ...row.replacementsTo.map((r) => r.student.userId),
      ]),
    ].sort(),
  };
}

/**
 * Lesson facts as they are now in the transaction (call after the write
 * for "after" facts, before it for "before" facts).
 */
export async function loadLessonFacts(
  tx: Tx,
  lessonIds: readonly string[],
): Promise<Map<string, LessonFacts>> {
  if (lessonIds.length === 0) return new Map();
  const rows = await tx.lesson.findMany({
    where: { id: { in: [...new Set(lessonIds)] } },
    select: lessonFactsSelect(),
  });
  return new Map(rows.map((row) => [row.id, toFacts(row)]));
}

export async function loadLessonFact(
  tx: Tx,
  lessonId: string,
): Promise<LessonFacts | null> {
  return (await loadLessonFacts(tx, [lessonId])).get(lessonId) ?? null;
}

/** A student or teacher profile as a recipient. */
export async function studentPerson(tx: Tx, studentId: string) {
  const row = await tx.studentProfile.findFirst({
    where: { id: studentId },
    select: { userId: true, user: { select: { name: true } } },
  });
  return row ? { userId: row.userId, name: row.user.name } : null;
}

export async function teacherPerson(tx: Tx, teacherId: string) {
  const row = await tx.teacherProfile.findFirst({
    where: { id: teacherId },
    select: { userId: true, user: { select: { name: true } } },
  });
  return row ? { userId: row.userId, name: row.user.name } : null;
}

/** Every admin of the school who can sign in (§2.2 review queue). */
export async function adminIds(tx: Tx): Promise<string[]> {
  const rows = await tx.membership.findMany({
    where: { role: "ADMIN", user: { deletedAt: null } },
    select: { userId: true },
    orderBy: { userId: "asc" },
  });
  return rows.map((r) => r.userId);
}
