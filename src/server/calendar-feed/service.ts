// Calendar links: the database service (docs/architecture/phase5-rules.md
// §5). The signed-in teacher or student creates, shows and resets their own
// link through the school-scoped client; an admin can turn a user's link
// off without ever seeing it. `loadFeedByToken` is the public route's
// loader: it authenticates by token alone and then reads only the feed
// row's school and user.

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { AdminError, msg } from "@/server/admin/result";
import type { Role } from "@/server/auth/roles";
import { scopeToSchool } from "@/server/db/school-scope";
import { isUuid } from "@/server/lessons/access";
import { notify } from "@/server/notifications/service";
import { ACTIVE_REPLACEMENT } from "@/server/replacements/release";
import type { SchoolDb, Tx } from "@/server/timetable/service";
import { membershipLessonWhere } from "@/server/timetable/views";

import { FEED_FUTURE_DAYS, FEED_PAST_DAYS, type FeedLesson } from "./build";
import { feedPath, feedSecret, hashToken, newSalt, tokenFor } from "./token";

const DAY_MS = 86_400_000;
/** `lastUsedAt` is written at most this often (no write per poll). */
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

/** Who owns a link: a teacher or student of this school. */
export type FeedOwner = { userId: string; role: Role };

/** The viewer's link as their calendar page shows it. */
export type MyCalendarFeed = {
  /** Null when there is no active link. */
  link: { url: string; createdAt: Date } | null;
  /** No active link because an admin turned the last one off (§5.1). */
  revokedByAdmin: boolean;
};

const canHaveFeed = (role: Role) => role === "TEACHER" || role === "STUDENT";

function assertOwner(owner: FeedOwner) {
  // Admins have no feed in v1 (owner decision 7); the pages 403 them first.
  if (!canHaveFeed(owner.role))
    throw new AdminError(msg("errors.forbidden.title"));
}

const urlOf = (origin: string, salt: Uint8Array) =>
  `${origin}${feedPath(tokenFor(feedSecret(), salt))}`;

/** The active link of the viewer, recomputed from its salt (_Copy link_). */
export async function loadMyFeed(
  db: SchoolDb,
  owner: FeedOwner,
  origin: string,
): Promise<MyCalendarFeed> {
  assertOwner(owner);
  const active = await db.calendarFeed.findFirst({
    where: { userId: owner.userId, revokedAt: null },
    select: { salt: true, createdAt: true },
  });
  if (active) {
    return {
      link: { url: urlOf(origin, active.salt), createdAt: active.createdAt },
      revokedByAdmin: false,
    };
  }
  // A reset always creates a new link, so earlier links without an active
  // one mean an admin turned the last one off.
  const earlier = await db.calendarFeed.count({
    where: { userId: owner.userId },
  });
  return { link: null, revokedByAdmin: earlier > 0 };
}

async function schoolIdOf(tx: Tx) {
  return (await tx.school.findFirstOrThrow({ select: { id: true } })).id;
}

async function insertFeed(tx: Tx, owner: FeedOwner, now: Date) {
  const salt = newSalt();
  const feed = await tx.calendarFeed.create({
    data: {
      schoolId: await schoolIdOf(tx),
      userId: owner.userId,
      salt,
      tokenHash: hashToken(tokenFor(feedSecret(), salt)),
      createdAt: now,
    },
    select: { id: true },
  });
  return feed.id;
}

async function audit(
  tx: Tx,
  actorId: string,
  action: string,
  feedId: string,
  userId: string,
) {
  // Never the token or the salt.
  return tx.auditLog.create({
    data: {
      schoolId: await schoolIdOf(tx),
      actorId,
      action,
      entityType: "CalendarFeed",
      entityId: feedId,
      data: { userId },
    },
    select: { id: true },
  });
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";

/**
 * _Create my calendar link_ (§5.1). Idempotent: with an active link already
 * (a double click, two tabs) nothing changes.
 */
export async function createMyFeed(
  db: SchoolDb,
  owner: FeedOwner,
  now: Date,
): Promise<void> {
  assertOwner(owner);
  try {
    await db.$transaction(async (tx) => {
      const active = await tx.calendarFeed.findFirst({
        where: { userId: owner.userId, revokedAt: null },
        select: { id: true },
      });
      if (active) return;
      const id = await insertFeed(tx, owner, now);
      await audit(tx, owner.userId, "calendar_feed.created", id, owner.userId);
    });
  } catch (error) {
    // A concurrent create won the partial unique index: same outcome.
    if (!isUniqueViolation(error)) throw error;
  }
}

/**
 * _Reset link_ (§5.1): revokes the active link and creates a new one in one
 * transaction, so the old URL stops working at once.
 */
export async function resetMyFeed(
  db: SchoolDb,
  owner: FeedOwner,
  now: Date,
): Promise<void> {
  assertOwner(owner);
  await db.$transaction(async (tx) => {
    await tx.calendarFeed.updateMany({
      where: { userId: owner.userId, revokedAt: null },
      data: { revokedAt: now },
    });
    const id = await insertFeed(tx, owner, now);
    await audit(tx, owner.userId, "calendar_feed.reset", id, owner.userId);
  });
}

/** Whether a user has an active link (the admin's _Turn off_ button). */
export async function hasActiveFeed(
  db: SchoolDb,
  userId: string,
): Promise<boolean> {
  if (!isUuid(userId)) return false;
  return (
    (await db.calendarFeed.count({ where: { userId, revokedAt: null } })) > 0
  );
}

/**
 * An admin turns a user's link off (§5.1): revoked, no new link (the admin
 * never sees one), audited, and the user gets `CALENDAR_FEED_REVOKED`.
 * Returns false when there was no active link.
 */
export async function revokeFeedAsAdmin(
  db: SchoolDb,
  actor: { userId: string },
  userId: string,
  now: Date,
): Promise<boolean> {
  if (!isUuid(userId)) return false;
  return db.$transaction(async (tx) => {
    const membership = await tx.membership.findFirst({
      where: { userId },
      select: { role: true },
    });
    if (!membership || !canHaveFeed(membership.role)) return false;
    const active = await tx.calendarFeed.findFirst({
      where: { userId, revokedAt: null },
      select: { id: true },
    });
    if (!active) return false;
    const { count } = await tx.calendarFeed.updateMany({
      where: { id: active.id, revokedAt: null },
      data: { revokedAt: now },
    });
    if (count !== 1) return false;
    const log = await audit(
      tx,
      actor.userId,
      "calendar_feed.revoked",
      active.id,
      userId,
    );
    await notify(
      tx,
      { sourceId: log.id, actorId: actor.userId },
      [
        {
          type: "CALENDAR_FEED_REVOKED",
          userId,
          audience: membership.role === "TEACHER" ? "teacher" : "student",
        },
      ],
      now,
    );
    return true;
  });
}

// ---------------------------------------------------------------------------
// The public feed route
// ---------------------------------------------------------------------------

/** Everything the route needs to build one feed. */
export type LoadedFeed = {
  role: "TEACHER" | "STUDENT";
  school: { name: string; timezone: string };
  lessons: FeedLesson[];
};

const feedLessonSelect = {
  id: true,
  startsAt: true,
  endsAt: true,
  updatedAt: true,
  status: true,
  cancelReason: true,
  teacherId: true,
  substituteTeacherId: true,
  group: {
    select: { name: true, type: true, level: { select: { code: true } } },
  },
  room: { select: { name: true } },
  teacher: { select: { user: { select: { name: true } } } },
  substituteTeacher: { select: { user: { select: { name: true } } } },
} satisfies Prisma.LessonSelect;

type FeedLessonRow = Prisma.LessonGetPayload<{
  select: typeof feedLessonSelect;
}>;

function toFeedLesson(
  row: FeedLessonRow,
  viewerIs: FeedLesson["viewerIs"],
  notAttending: boolean,
): FeedLesson {
  return {
    id: row.id,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    updatedAt: row.updatedAt,
    cancelled: row.status === "CANCELLED",
    cancelReason: row.cancelReason,
    groupName: row.group.name,
    lessonType: row.group.type,
    level: row.group.level.code,
    room: row.room?.name ?? null,
    teacherName: row.teacher.user.name,
    substituteName: row.substituteTeacher?.user.name ?? null,
    viewerIs,
    notAttending,
  };
}

/** Lessons starting inside the feed window, in published terms (§5.3). */
export function feedWindowWhere(now: Date): Prisma.LessonWhereInput {
  return {
    startsAt: {
      gte: new Date(now.getTime() - FEED_PAST_DAYS * DAY_MS),
      lt: new Date(now.getTime() + FEED_FUTURE_DAYS * DAY_MS),
    },
    term: { timetablePublishedAt: { not: null } },
  };
}

/** A teacher's lessons: effective teacher = me, or covered for me (§5.3). */
async function teacherFeedLessons(
  db: SchoolDb,
  userId: string,
  now: Date,
): Promise<FeedLesson[]> {
  const profile = await db.teacherProfile.findFirst({
    where: { userId },
    select: { id: true },
  });
  if (!profile) return [];
  const rows = await db.lesson.findMany({
    where: {
      AND: [
        feedWindowWhere(now),
        {
          OR: [{ teacherId: profile.id }, { substituteTeacherId: profile.id }],
        },
      ],
    },
    select: feedLessonSelect,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
  return rows.map((row) =>
    toFeedLesson(
      row,
      row.substituteTeacherId === profile.id ? "substitute" : "regular",
      false,
    ),
  );
}

/**
 * A student's lessons: of groups they're a member of on the lesson date,
 * plus lessons they hold an active replacement into (§5.3). Lessons with
 * their absence report are marked _Not attending_.
 */
async function studentFeedLessons(
  db: SchoolDb,
  userId: string,
  now: Date,
): Promise<FeedLesson[]> {
  const profile = await db.studentProfile.findFirst({
    where: { userId },
    select: {
      id: true,
      groupMemberships: {
        select: { groupId: true, joinedAt: true, leftAt: true },
      },
      replacementRequests: {
        where: { status: { in: [...ACTIVE_REPLACEMENT] } },
        select: { targetLessonId: true },
      },
    },
  });
  if (!profile) return [];
  const booked = profile.replacementRequests.map((r) => r.targetLessonId);
  const rows = await db.lesson.findMany({
    where: {
      AND: [
        feedWindowWhere(now),
        {
          OR: [
            membershipLessonWhere(profile.groupMemberships),
            ...(booked.length > 0 ? [{ id: { in: booked } }] : []),
          ],
        },
      ],
    },
    select: {
      ...feedLessonSelect,
      // Only whether *this* student reported an absence; never the reason.
      absenceReports: {
        where: { studentId: profile.id },
        select: { id: true },
      },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
  return rows.map(({ absenceReports, ...row }) =>
    toFeedLesson(row, "student", absenceReports.length > 0),
  );
}

/**
 * The public route's loader (§5.2). Authenticates by token alone: unknown,
 * revoked, a deleted user or no `TEACHER`/`STUDENT` membership in the feed
 * row's school → null (the route answers 404). Every query after the token
 * lookup runs on the feed row's school, for the feed row's user, with the
 * role read from the membership now.
 */
export async function loadFeedByToken(
  client: PrismaClient,
  token: string,
  now: Date,
): Promise<LoadedFeed | null> {
  // The only global lookup of the phase: the hash of a 256-bit secret.
  const feed = await client.calendarFeed.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      schoolId: true,
      userId: true,
      revokedAt: true,
      lastUsedAt: true,
    },
  });
  if (!feed || feed.revokedAt) return null;

  const db = scopeToSchool(client, feed.schoolId);
  const membership = await db.membership.findFirst({
    where: { userId: feed.userId, user: { deletedAt: null } },
    select: {
      role: true,
      school: { select: { name: true, timezone: true } },
    },
  });
  if (!membership) return null;
  const { role } = membership;
  if (role !== "TEACHER" && role !== "STUDENT") return null;

  if (
    !feed.lastUsedAt ||
    now.getTime() - feed.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS
  ) {
    await db.calendarFeed.updateMany({
      where: { id: feed.id },
      data: { lastUsedAt: now },
    });
  }

  return {
    role,
    school: membership.school,
    lessons:
      role === "TEACHER"
        ? await teacherFeedLessons(db, feed.userId, now)
        : await studentFeedLessons(db, feed.userId, now),
  };
}
