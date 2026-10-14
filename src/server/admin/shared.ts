import { Prisma } from "@/generated/prisma/client";
import { toCalendarDate } from "@/lib/i18n/dates";
import { fromIsoDate } from "@/server/scheduling";
import type { SchoolDb } from "@/server/timetable/service";

import { AdminError, msg } from "./result";

export type { SchoolDb };
export type Actor = { userId: string };

/**
 * What every admin service function gets: the school-scoped client, the
 * school's id (Prisma's create types need it explicitly; the scoped client
 * rejects any other value) and the acting admin for the audit log.
 */
export type Scope = { db: SchoolDb; schoolId: string; actor: Actor };

/** Today's calendar date in the school's time zone, as a `@db.Date` value. */
export function schoolToday(timezone: string, now = new Date()): Date {
  return fromIsoDate(toCalendarDate(now, timezone));
}

/**
 * Slots that still run: in a term that hasn't ended and not ended
 * themselves (§5.3 "slots in a current or future term").
 */
export function activeSlotWhere(today: Date) {
  return {
    term: { endDate: { gte: today } },
    OR: [{ validUntil: null }, { validUntil: { gte: today } }],
  };
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/** `validation.unique` on `field`, e.g. Name "Room 1" is already used. */
export function uniqueError(field: string, label: string, value: string) {
  return new AdminError(
    msg("validation.unique", { field: msg(label), value }),
    field,
  );
}

export function notFound(): AdminError {
  return new AdminError(msg("common.error.notFound"));
}

/** Append-only audit row. Never put passwords into `data`. */
export function audit(
  { db, schoolId, actor }: Scope,
  action: string,
  entityType: string,
  entityId: string,
  data?: Prisma.InputJsonValue,
) {
  return db.auditLog.create({
    data: {
      schoolId,
      actorId: actor.userId,
      action,
      entityType,
      entityId,
      data,
    },
  });
}

/** Rejects a stale form (§5.2 optimistic concurrency). */
export function assertFresh(
  record: { updatedAt: Date },
  expected: string | null | undefined,
) {
  if (expected && record.updatedAt.toISOString() !== expected) {
    throw new AdminError(msg("common.error.staleData"));
  }
}
