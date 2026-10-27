// Notification inbox (docs/architecture/phase5-rules.md §2.7): the
// viewer's own rows only, newest first, inside the retention window, with
// each item's link resolved for the viewer's role. Every function takes the
// school-scoped client and the viewer; any signed-in member may call them.

import type { Prisma } from "@/generated/prisma/client";
import { loadStudentScope, studentLessonWhere } from "@/server/lessons/student";
import { toZonedDateTime } from "@/server/scheduling";
import type { SchoolDb } from "@/server/timetable/service";

import {
  type Audience,
  type NotificationLink,
  type NotificationParams,
  type NotificationType,
  retentionCutoff,
  UNREAD_COUNT_CAP,
} from "./rules";

export type InboxViewer = {
  userId: string;
  role: "ADMIN" | "TEACHER" | "STUDENT";
};

export type InboxRow = {
  id: string;
  type: NotificationType;
  audience: Audience;
  params: NotificationParams;
  link: NotificationLink | null;
  createdAt: Date;
  readAt: Date | null;
  /** Where the item leads for this viewer; null = "No longer available". */
  href: string | null;
};

export type InboxPage = {
  items: InboxRow[];
  /** Pass back to get the next page; null on the last page. */
  nextCursor: string | null;
};

/** `(createdAt, id)` keyset cursor. */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

export function decodeCursor(
  cursor: string | null | undefined,
): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split("|");
  const createdAt = new Date(at ?? "");
  if (Number.isNaN(createdAt.getTime()) || !id || !UUID.test(id)) return null;
  return { createdAt, id };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The viewer's own rows inside the retention window (§2.5). */
const visible = (
  viewer: InboxViewer,
  now: Date,
): Prisma.NotificationWhereInput => ({
  recipientId: viewer.userId,
  createdAt: { gt: retentionCutoff(now) },
});

/** Deletes the viewer's expired rows (the lazy purge, §2.5). */
export async function purgeOwn(db: SchoolDb, viewer: InboxViewer, now: Date) {
  await db.notification.deleteMany({
    where: {
      recipientId: viewer.userId,
      createdAt: { lte: retentionCutoff(now) },
    },
  });
}

/**
 * One page of the viewer's notifications, newest first (§2.7). Runs the
 * purge first. Each item has its `href` for the viewer's role, or null.
 */
export async function listNotifications(
  db: SchoolDb,
  viewer: InboxViewer,
  options: { cursor?: string | null; unreadOnly?: boolean; limit: number },
  now: Date,
): Promise<InboxPage> {
  await purgeOwn(db, viewer, now);
  const cursor = decodeCursor(options.cursor);
  const rows = await db.notification.findMany({
    where: {
      AND: [
        visible(viewer, now),
        options.unreadOnly ? { readAt: null } : {},
        cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {},
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
    select: {
      id: true,
      type: true,
      audience: true,
      params: true,
      link: true,
      createdAt: true,
      readAt: true,
    },
  });
  const page = rows.slice(0, options.limit);
  const hrefs = await resolveHrefs(
    db,
    viewer,
    page.map((r) => r.link as NotificationLink | null),
    now,
  );
  return {
    items: page.map((row, i) => ({
      id: row.id,
      type: row.type,
      audience: row.audience as Audience,
      params: row.params as NotificationParams,
      link: row.link as NotificationLink | null,
      createdAt: row.createdAt,
      readAt: row.readAt,
      href: hrefs[i],
    })),
    nextCursor:
      rows.length > options.limit ? encodeCursor(page[page.length - 1]) : null,
  };
}

/** Own unread rows inside the retention window, counted up to 100. */
export async function unreadCount(
  db: SchoolDb,
  viewer: InboxViewer,
  now: Date,
): Promise<number> {
  return db.notification.count({
    where: { ...visible(viewer, now), readAt: null },
    take: UNREAD_COUNT_CAP,
  });
}

/**
 * Marks one of the viewer's notifications read and returns its `href`.
 * Another user's or school's id, or an expired one, is null (NOT_FOUND).
 * Idempotent: an already read row keeps its first `readAt`.
 */
export async function markRead(
  db: SchoolDb,
  viewer: InboxViewer,
  id: string,
  now: Date,
): Promise<{ href: string | null } | null> {
  if (!UUID.test(id)) return null;
  const row = await db.notification.findFirst({
    where: { ...visible(viewer, now), id },
    select: { id: true, link: true },
  });
  if (!row) return null;
  await db.notification.updateMany({
    where: { id: row.id, recipientId: viewer.userId, readAt: null },
    data: { readAt: now },
  });
  const [href] = await resolveHrefs(
    db,
    viewer,
    [row.link as NotificationLink | null],
    now,
  );
  return { href };
}

/**
 * Marks read the viewer's unread rows up to `upTo` (the newest row the
 * client has shown), so one arriving meanwhile stays unread (§2.7).
 */
export async function markAllRead(
  db: SchoolDb,
  viewer: InboxViewer,
  upTo: string,
  now: Date,
): Promise<number | null> {
  const cursor = decodeCursor(upTo);
  if (!cursor) return null;
  const { count } = await db.notification.updateMany({
    where: {
      AND: [
        visible(viewer, now),
        { readAt: null },
        {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lte: cursor.id } },
          ],
        },
      ],
    },
    data: { readAt: now },
  });
  return count;
}

// ---------------------------------------------------------------------------
// Links (§2.4)
// ---------------------------------------------------------------------------

const ROLE_PATH = {
  ADMIN: "admin",
  TEACHER: "teacher",
  STUDENT: "student",
} as const;

/**
 * Resolves stored links for the viewer's role, with one batched access query
 * for the lesson links: the same rules as the lesson pages, so a target the
 * viewer can no longer read is null. A student's lesson that hasn't started
 * yet (its page opens at the start) leads to its timetable week.
 */
export async function resolveHrefs(
  db: SchoolDb,
  viewer: InboxViewer,
  links: readonly (NotificationLink | null)[],
  now: Date,
): Promise<(string | null)[]> {
  const base = `/${ROLE_PATH[viewer.role]}`;
  const lessonIds = [
    ...new Set(
      links.flatMap((l) =>
        l?.kind === "lesson" && UUID.test(l.lessonId) ? [l.lessonId] : [],
      ),
    ),
  ];
  const lessons = await readableLessons(db, viewer, lessonIds, now);
  return links.map((link) => {
    if (!link) return null;
    switch (link.kind) {
      case "lesson": {
        const lesson = lessons.get(link.lessonId);
        if (!lesson) return null;
        return lesson.page
          ? `${base}/lessons/${link.lessonId}`
          : `${base}/timetable?week=${lesson.date}`;
      }
      case "timetable":
        return /^\d{4}-\d{2}-\d{2}$/.test(link.date)
          ? `${base}/timetable?week=${link.date}`
          : `${base}/timetable`;
      case "replacementReview":
        return viewer.role === "ADMIN" ? "/admin/absences?tab=review" : null;
      case "absences":
        return viewer.role === "STUDENT" ? "/student/absences" : null;
      case "calendarFeed":
        return viewer.role === "ADMIN" ? null : `${base}/calendar`;
      case "availability":
        if (viewer.role === "TEACHER") return "/teacher/availability";
        return viewer.role === "ADMIN" && UUID.test(link.teacherId)
          ? `/admin/teachers/${link.teacherId}?tab=availability`
          : null;
    }
  });
}

async function readableLessons(
  db: SchoolDb,
  viewer: InboxViewer,
  ids: string[],
  now: Date,
): Promise<Map<string, { page: boolean; date: string }>> {
  if (ids.length === 0) return new Map();
  const { timezone } = await db.school.findFirstOrThrow({
    select: { timezone: true },
  });
  const date = (at: Date) => toZonedDateTime(at, timezone).date;
  if (viewer.role === "ADMIN") {
    const rows = await db.lesson.findMany({
      where: { id: { in: ids } },
      select: { id: true, startsAt: true },
    });
    return new Map(
      rows.map((r) => [r.id, { page: true, date: date(r.startsAt) }]),
    );
  }
  if (viewer.role === "TEACHER") {
    const profile = await db.teacherProfile.findFirst({
      where: { userId: viewer.userId },
      select: { id: true },
    });
    if (!profile) return new Map();
    const rows = await db.lesson.findMany({
      where: {
        id: { in: ids },
        OR: [{ teacherId: profile.id }, { substituteTeacherId: profile.id }],
        term: { timetablePublishedAt: { not: null } },
      },
      select: { id: true, startsAt: true },
    });
    return new Map(
      rows.map((r) => [r.id, { page: true, date: date(r.startsAt) }]),
    );
  }
  const scope = await loadStudentScope(db, viewer.userId);
  if (!scope.studentId) return new Map();
  // The student's lessons whatever their start; the page itself opens once
  // the lesson has started (lessons.md §2).
  const rows = await db.lesson.findMany({
    where: {
      AND: [
        { id: { in: ids } },
        studentLessonWhere(
          scope.memberships,
          FAR_FUTURE,
          scope.bookedLessonIds,
        ),
      ],
    },
    select: { id: true, startsAt: true },
  });
  return new Map(
    rows.map((r) => [
      r.id,
      { page: r.startsAt.getTime() <= now.getTime(), date: date(r.startsAt) },
    ]),
  );
}

const FAR_FUTURE = new Date(8.64e15);
