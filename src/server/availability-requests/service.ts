import { toCalendarDate } from "@/lib/i18n/dates";
import type {
  ExceptionInput,
  WeeklyInput,
} from "@/server/admin/availability/schema";
import {
  deleteAvailability,
  saveException,
  saveWeekly,
} from "@/server/admin/availability/service";
import { AdminError, msg } from "@/server/admin/result";
import { notFound, type SchoolDb, type Scope } from "@/server/admin/shared";
import type { NotificationEvent } from "@/server/notifications/rules";
import { adminIds, notify } from "@/server/notifications/service";
import { toIsoDate } from "@/server/scheduling/time";
import type { Tx } from "@/server/timetable/service";

import {
  parsePayload,
  payloadJson,
  RECENT_DECISION_DAYS,
  type RequestPayload,
  type RequestView,
  type RuleSnapshot,
} from "./schema";

/**
 * Availability change requests (docs/design/availability-requests.md).
 * Teachers propose; nothing in `TeacherAvailability` changes until an admin
 * approves, and approval goes through the admin availability service so the
 * merge rules, audit and "affected lessons" count are the same as for an
 * admin's own edit. `teacherId` is always the `TeacherProfile` id the caller
 * resolved for the signed-in teacher (or the admin's detail page), never a
 * value taken from the client on its own.
 */

const DAY_MS = 86_400_000;

const alreadyDecided = () =>
  new AdminError(msg("availabilityRequests.error.alreadyDecided"));

async function teacherOf(db: SchoolDb | Tx, teacherId: string) {
  const teacher = await db.teacherProfile.findFirst({
    where: { id: teacherId },
    select: { id: true, userId: true, user: { select: { name: true } } },
  });
  if (!teacher) throw notFound();
  return { id: teacher.id, userId: teacher.userId, name: teacher.user.name };
}

async function snapshotOf(
  db: SchoolDb,
  teacherId: string,
  ruleId: string,
): Promise<RuleSnapshot> {
  const rule = await db.teacherAvailability.findFirst({
    where: { id: ruleId, teacherId },
    select: {
      kind: true,
      weekday: true,
      date: true,
      startMinute: true,
      endMinute: true,
      note: true,
    },
  });
  if (!rule) throw notFound();
  return { ...rule, date: rule.date ? toIsoDate(rule.date) : null };
}

async function assertNoPendingFor(db: SchoolDb, teacherId: string, id: string) {
  const pending = await db.availabilityRequest.findFirst({
    where: { teacherId, targetId: id, status: "PENDING" },
    select: { id: true },
  });
  if (pending) {
    throw new AdminError(msg("availabilityRequests.error.alreadyPending"));
  }
}

async function auditRow(
  tx: Tx,
  scope: Scope,
  action: string,
  requestId: string,
  data: Record<string, unknown>,
) {
  const row = await tx.auditLog.create({
    data: {
      schoolId: scope.schoolId,
      actorId: scope.actor.userId,
      action,
      entityType: "AvailabilityRequest",
      entityId: requestId,
      data: JSON.parse(JSON.stringify(data)),
    },
    select: { id: true },
  });
  return row.id;
}

async function createRequest(
  scope: Scope,
  teacherId: string,
  payload: RequestPayload,
  targetId: string | null,
  now: Date,
) {
  const { db, schoolId } = scope;
  return db.$transaction(async (tx) => {
    const teacher = await teacherOf(tx, teacherId);
    const request = await tx.availabilityRequest.create({
      data: {
        schoolId,
        teacherId,
        kind: payload.kind,
        targetId,
        payload: payloadJson(payload),
      },
      select: { id: true },
    });
    const sourceId = await auditRow(
      tx,
      scope,
      "availability_request.created",
      request.id,
      { teacherId, kind: payload.kind, targetId },
    );
    await notify(
      tx,
      { sourceId, actorId: scope.actor.userId },
      [
        {
          type: "AVAILABILITY_REQUEST_PENDING",
          adminIds: await adminIds(tx),
          teacher: { id: teacher.id, name: teacher.name },
        },
      ],
      now,
    );
    return { id: request.id };
  });
}

/** Weekly unavailability: a new rule, or (`replaceId`) a change to one. */
export async function requestWeekly(
  scope: Scope,
  teacherId: string,
  weekly: WeeklyInput,
  replaceId: string | null,
  now: Date,
) {
  if (!replaceId) {
    return createRequest(
      scope,
      teacherId,
      { kind: "ADD_WEEKLY", weekly },
      null,
      now,
    );
  }
  const target = await snapshotOf(scope.db, teacherId, replaceId);
  if (target.kind !== "WEEKLY_UNAVAILABLE") throw notFound();
  await assertNoPendingFor(scope.db, teacherId, replaceId);
  return createRequest(
    scope,
    teacherId,
    { kind: "EDIT_WEEKLY", weekly, target },
    replaceId,
    now,
  );
}

/** A one-off exception. Teachers can't ask for days that have passed. */
export async function requestException(
  scope: Scope,
  teacherId: string,
  exception: ExceptionInput,
  timezone: string,
  now: Date,
) {
  if (exception.dates.length === 0) {
    throw new AdminError(msg("availability.error.rangeTooLong"), "dateTo");
  }
  if (exception.dates[0] < toCalendarDate(now, timezone)) {
    throw new AdminError(msg("availabilityRequests.error.pastDate"), "date");
  }
  return createRequest(
    scope,
    teacherId,
    { kind: "ADD_EXCEPTION", exception },
    null,
    now,
  );
}

/** Removing one of the teacher's rules (weekly or exception). */
export async function requestDelete(
  scope: Scope,
  teacherId: string,
  ruleId: string,
  now: Date,
) {
  const target = await snapshotOf(scope.db, teacherId, ruleId);
  await assertNoPendingFor(scope.db, teacherId, ruleId);
  return createRequest(
    scope,
    teacherId,
    { kind: "DELETE_RULE", target },
    ruleId,
    now,
  );
}

/** The teacher takes back a request no admin has decided yet. */
export async function withdrawRequest(
  scope: Scope,
  teacherId: string,
  requestId: string,
) {
  await scope.db.$transaction(async (tx) => {
    const { count } = await tx.availabilityRequest.updateMany({
      where: { id: requestId, teacherId, status: "PENDING" },
      data: { status: "WITHDRAWN" },
    });
    if (count === 0) {
      const exists = await tx.availabilityRequest.findFirst({
        where: { id: requestId, teacherId },
        select: { id: true },
      });
      throw exists ? alreadyDecided() : notFound();
    }
    await auditRow(tx, scope, "availability_request.withdrawn", requestId, {
      teacherId,
    });
  });
}

/**
 * A teacher's pending requests (oldest first) and the ones decided in the
 * last `RECENT_DECISION_DAYS` (newest first). Withdrawn ones are not shown.
 */
export async function listRequests(
  db: SchoolDb,
  teacherId: string,
  now: Date,
): Promise<{ pending: RequestView[]; recent: RequestView[] }> {
  const rows = await db.availabilityRequest.findMany({
    where: {
      teacherId,
      OR: [
        { status: "PENDING" },
        {
          status: { in: ["APPROVED", "REJECTED"] },
          reviewedAt: {
            gte: new Date(now.getTime() - RECENT_DECISION_DAYS * DAY_MS),
          },
        },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      targetId: true,
      payload: true,
      status: true,
      createdAt: true,
      reviewedAt: true,
      reviewNote: true,
    },
  });
  const views = rows.map((row): RequestView => ({
    ...parsePayload(row.kind, row.payload),
    id: row.id,
    targetId: row.targetId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
  }));
  return {
    pending: views.filter((view) => view.status === "PENDING"),
    recent: views
      .filter((view) => view.status !== "PENDING")
      .sort((a, b) => (b.reviewedAt ?? "").localeCompare(a.reviewedAt ?? "")),
  };
}

/** Pending requests per `TeacherProfile.id` (the admin teacher list). */
export async function pendingCounts(db: SchoolDb) {
  const rows = await db.availabilityRequest.groupBy({
    by: ["teacherId"],
    where: { status: "PENDING" },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.teacherId, row._count._all]));
}

async function decide(
  scope: Scope,
  teacherId: string,
  requestId: string,
  outcome: "approved" | "rejected",
  note: string | null,
  now: Date,
) {
  await scope.db.$transaction(async (tx) => {
    const teacher = await teacherOf(tx, teacherId);
    const sourceId = await auditRow(
      tx,
      scope,
      `availability_request.${outcome}`,
      requestId,
      { teacherId, note },
    );
    const event: NotificationEvent = {
      type: "AVAILABILITY_REQUEST_DECIDED",
      userId: teacher.userId,
      teacherId,
      outcome,
      note,
    };
    await notify(tx, { sourceId, actorId: scope.actor.userId }, [event], now);
  });
}

/**
 * Applies a pending request. The request is claimed first (PENDING →
 * APPROVED), so two admins approving at once apply it only once; when
 * applying fails it goes back to PENDING. Returns how many scheduled
 * lessons an approved unavailability affects, like an admin's own save.
 */
export async function approveRequest(
  scope: Scope,
  teacherId: string,
  requestId: string,
  timezone: string,
  now: Date,
) {
  const { db } = scope;
  const row = await db.availabilityRequest.findFirst({
    where: { id: requestId, teacherId },
    select: { kind: true, targetId: true, payload: true, status: true },
  });
  if (!row) throw notFound();
  if (row.status !== "PENDING") throw alreadyDecided();
  const payload = parsePayload(row.kind, row.payload);
  const { count } = await db.availabilityRequest.updateMany({
    where: { id: requestId, teacherId, status: "PENDING" },
    data: {
      status: "APPROVED",
      reviewedById: scope.actor.userId,
      reviewedAt: now,
    },
  });
  if (count === 0) throw alreadyDecided();
  let affected = 0;
  try {
    affected = await apply(scope, teacherId, payload, row.targetId, timezone);
  } catch (error) {
    await db.availabilityRequest.updateMany({
      where: { id: requestId, status: "APPROVED" },
      data: { status: "PENDING", reviewedById: null, reviewedAt: null },
    });
    throw error;
  }
  await decide(scope, teacherId, requestId, "approved", null, now);
  return { affected };
}

async function apply(
  scope: Scope,
  teacherId: string,
  payload: RequestPayload,
  targetId: string | null,
  timezone: string,
): Promise<number> {
  switch (payload.kind) {
    case "ADD_WEEKLY":
      await saveWeekly(scope, teacherId, payload.weekly, null);
      return 0;
    case "EDIT_WEEKLY":
      try {
        await saveWeekly(scope, teacherId, payload.weekly, targetId);
      } catch (error) {
        if (error instanceof AdminError) {
          throw new AdminError(msg("availabilityRequests.error.targetGone"));
        }
        throw error;
      }
      return 0;
    case "ADD_EXCEPTION": {
      const result = await saveException(
        scope,
        teacherId,
        payload.exception,
        timezone,
      );
      return result.affected;
    }
    case "DELETE_RULE":
      if (!targetId) return 0;
      try {
        await deleteAvailability(scope, teacherId, targetId);
      } catch (error) {
        // Already gone (an admin deleted it meanwhile): the wish holds.
        if (!(error instanceof AdminError)) throw error;
      }
      return 0;
  }
}

export async function rejectRequest(
  scope: Scope,
  teacherId: string,
  requestId: string,
  note: string | null,
  now: Date,
) {
  const { count } = await scope.db.availabilityRequest.updateMany({
    where: { id: requestId, teacherId, status: "PENDING" },
    data: {
      status: "REJECTED",
      reviewedById: scope.actor.userId,
      reviewedAt: now,
      reviewNote: note,
    },
  });
  if (count === 0) {
    const exists = await scope.db.availabilityRequest.findFirst({
      where: { id: requestId, teacherId },
      select: { id: true },
    });
    throw exists ? alreadyDecided() : notFound();
  }
  await decide(scope, teacherId, requestId, "rejected", note, now);
}
