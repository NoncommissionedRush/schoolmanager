// Notifications of bulk timetable changes (docs/architecture/phase5-rules.md
// §2.3): the timetable editor, holidays, publish, regenerate and the
// generator's apply never send one notification per lesson. Their shared
// transaction (`inTransaction`) tracks the lessons they touch: the lesson
// writers record the lessons' state before the first change and the ids
// they create; at the end, one `TIMETABLE_CHANGED` per person and term with
// the counts, or `TIMETABLE_PUBLISHED` for a term published the first time.

import { toIsoDate } from "@/server/scheduling";
import type { Tx } from "@/server/timetable/service";

import {
  type LessonSnapshot,
  type NotificationEvent,
  summarizeLessonChanges,
  type TermFacts,
} from "./rules";
import { loadLessonFacts, notify, type NotifySource } from "./service";

type Tracker = {
  before: Map<string, Snapshot>;
  created: Set<string>;
  firstPublished: Set<string>;
  source: NotifySource | null;
};

// Keyed by the transaction client, which every writer receives.
const trackers = new WeakMap<object, Tracker>();

/** Starts tracking lesson changes made through `tx`. */
export function trackTimetableChanges(tx: Tx): void {
  trackers.set(tx, {
    before: new Map(),
    created: new Set(),
    firstPublished: new Set(),
    source: null,
  });
}

/**
 * Records the state of `lessonIds` before they change (the first capture
 * of a lesson wins). A no-op outside a tracked transaction.
 */
export async function captureBefore(
  tx: Tx,
  lessonIds: readonly string[],
): Promise<void> {
  const tracker = trackers.get(tx);
  if (!tracker) return;
  const ids = lessonIds.filter(
    (id) => !tracker.before.has(id) && !tracker.created.has(id),
  );
  for (const snapshot of await loadSnapshots(tx, ids)) {
    tracker.before.set(snapshot.id, snapshot);
  }
}

/** Records lessons created by the action. */
export function recordCreated(tx: Tx, lessonIds: readonly string[]): void {
  const tracker = trackers.get(tx);
  if (!tracker) return;
  for (const id of lessonIds) tracker.created.add(id);
}

/** The action's audit log row: the notifications' source (§2.5). */
export function recordSource(tx: Tx, source: NotifySource): void {
  const tracker = trackers.get(tx);
  if (tracker) tracker.source = source;
}

/** The term was published for the first time in this action. */
export function markFirstPublish(tx: Tx, termId: string): void {
  trackers.get(tx)?.firstPublished.add(termId);
}

/**
 * Emits the notifications of everything tracked in `tx` and stops
 * tracking. Called at the end of the action, inside its transaction.
 */
export async function flushTimetableChanges(
  tx: Tx,
  now: Date,
): Promise<number> {
  const tracker = trackers.get(tx);
  trackers.delete(tx);
  if (!tracker?.source) return 0;
  const { before, created, firstPublished, source } = tracker;
  if (before.size === 0 && created.size === 0 && firstPublished.size === 0) {
    return 0;
  }
  const { timezone } = await tx.school.findFirstOrThrow({
    select: { timezone: true },
  });
  // Only published terms, and not a term published by this very action:
  // its people get `TIMETABLE_PUBLISHED` instead (§2.3).
  const counted = (s: Snapshot) => s.published && !firstPublished.has(s.termId);
  const after = await loadSnapshots(tx, [...before.keys(), ...created]);
  const summaries = summarizeLessonChanges(
    [...before.values()].filter(counted),
    after.filter(counted),
    { now, timeZone: timezone },
  );
  const termIds = [...new Set([...summaries.keys(), ...firstPublished])];
  const terms = new Map(
    (
      await tx.term.findMany({
        where: { id: { in: termIds } },
        select: { id: true, name: true, startDate: true, endDate: true },
      })
    ).map((t): [string, TermFacts] => [
      t.id,
      {
        id: t.id,
        name: t.name,
        startDate: toIsoDate(t.startDate),
        endDate: toIsoDate(t.endDate),
      },
    ]),
  );

  const events: NotificationEvent[] = [];
  for (const [termId, recipients] of [...summaries].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const term = terms.get(termId);
    if (term && recipients.length > 0) {
      events.push({ type: "TIMETABLE_CHANGED", term, recipients });
    }
  }
  for (const termId of [...firstPublished].sort()) {
    const term = terms.get(termId);
    if (term) {
      events.push({
        type: "TIMETABLE_PUBLISHED",
        term,
        recipients: await publishRecipients(tx, term, now),
      });
    }
  }
  return notify(tx, source, events, now);
}

/**
 * Who hears about a first publish (§2.2): every non-archived teacher with a
 * slot in the term and every student enrolled in a group with one, each
 * with their first lesson from now on (null if none).
 */
async function publishRecipients(tx: Tx, term: TermFacts, now: Date) {
  const slots = await tx.timetableSlot.findMany({
    where: { termId: term.id },
    select: {
      groupId: true,
      teacher: {
        select: { userId: true, user: { select: { deletedAt: true } } },
      },
    },
  });
  const groupIds = [...new Set(slots.map((s) => s.groupId))];
  const [memberships, lessons] = await Promise.all([
    tx.groupMembership.findMany({
      where: { groupId: { in: groupIds }, leftAt: null },
      select: { student: { select: { userId: true } } },
    }),
    tx.lesson.findMany({
      where: {
        termId: term.id,
        status: "SCHEDULED",
        startsAt: { gte: now },
      },
      select: { id: true, startsAt: true },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const facts = await loadLessonFacts(
    tx,
    lessons.map((l) => l.id),
  );
  const first = new Map<string, Date>();
  for (const lesson of lessons) {
    const f = facts.get(lesson.id);
    if (!f) continue;
    for (const id of [(f.substitute ?? f.teacher).userId, ...f.attendees]) {
      if (!first.has(id)) first.set(id, lesson.startsAt);
    }
  }
  const out = new Map<
    string,
    {
      userId: string;
      audience: "teacher" | "student";
      firstStartsAt: Date | null;
    }
  >();
  for (const slot of slots) {
    if (slot.teacher.user.deletedAt) continue;
    const id = slot.teacher.userId;
    out.set(id, {
      userId: id,
      audience: "teacher",
      firstStartsAt: first.get(id) ?? null,
    });
  }
  for (const m of memberships) {
    const id = m.student.userId;
    if (out.has(id)) continue;
    out.set(id, {
      userId: id,
      audience: "student",
      firstStartsAt: first.get(id) ?? null,
    });
  }
  return [...out.values()].sort((a, b) => a.userId.localeCompare(b.userId));
}

type Snapshot = LessonSnapshot & { published: boolean };

async function loadSnapshots(
  tx: Tx,
  lessonIds: readonly string[],
): Promise<Snapshot[]> {
  if (lessonIds.length === 0) return [];
  const ids = [...new Set(lessonIds)];
  const [rows, facts] = await Promise.all([
    tx.lesson.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        termId: true,
        groupId: true,
        occurrenceDate: true,
        startsAt: true,
        endsAt: true,
        roomId: true,
        status: true,
        teacher: { select: { userId: true } },
        substituteTeacher: { select: { userId: true } },
        term: { select: { timetablePublishedAt: true } },
      },
    }),
    loadLessonFacts(tx, ids),
  ]);
  return rows.map((row) => ({
    id: row.id,
    termId: row.termId,
    occurrence: row.occurrenceDate
      ? `${row.groupId}|${toIsoDate(row.occurrenceDate)}`
      : null,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    roomId: row.roomId,
    teacherId: row.teacher.userId,
    substituteId: row.substituteTeacher?.userId ?? null,
    cancelled: row.status === "CANCELLED",
    attendees: facts.get(row.id)?.attendees ?? [],
    published: row.term.timetablePublishedAt !== null,
  }));
}
