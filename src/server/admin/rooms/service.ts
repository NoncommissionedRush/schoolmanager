import type { RoomKind } from "@/generated/prisma/enums";

import { type ListParams, pageWindow, searchWhere, statusWhere } from "../list";
import { blockedError, msg } from "../result";
import {
  activeSlotWhere,
  audit,
  isUniqueViolation,
  notFound,
  type SchoolDb,
  type Scope,
  uniqueError,
} from "../shared";
import type { RoomInput } from "./schema";

export type RoomFilters = ListParams & { kind: RoomKind | null };

export async function listRooms(
  db: SchoolDb,
  filters: RoomFilters,
  today: Date,
) {
  const where = {
    ...statusWhere(filters.status, "archivedAt"),
    ...searchWhere(filters.q, ["name"]),
    ...(filters.kind ? { kind: filters.kind } : {}),
  };
  const total = await db.room.count({ where });
  const window = pageWindow(filters.page, total);
  const rooms = await db.room.findMany({
    where,
    orderBy: { name: "asc" },
    skip: window.skip,
    take: window.take,
    select: {
      id: true,
      name: true,
      kind: true,
      capacity: true,
      meetingUrl: true,
      archivedAt: true,
      updatedAt: true,
      _count: {
        select: { timetableSlots: { where: activeSlotWhere(today) } },
      },
    },
  });
  const [activeCount, anyCount] = await Promise.all([
    db.room.count({ where: { archivedAt: null } }),
    db.room.count(),
  ]);
  return {
    rooms: rooms.map(({ _count, ...room }) => ({
      ...room,
      activeSlots: _count.timetableSlots,
    })),
    total,
    window,
    activeCount,
    anyCount,
  };
}

async function assertNameFree(db: SchoolDb, name: string, exceptId?: string) {
  const clash = await db.room.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw uniqueError("name", "rooms.field.name", name);
}

/**
 * Groups using the room whose current member count exceeds its capacity —
 * a warning, not an error (§6.9).
 */
export async function capacityWarnings(
  db: SchoolDb,
  roomId: string,
  capacity: number | null,
  today: Date,
) {
  if (capacity === null) return [];
  const slots = await db.timetableSlot.findMany({
    where: { roomId, ...activeSlotWhere(today) },
    select: {
      group: {
        select: {
          name: true,
          _count: { select: { memberships: { where: { leftAt: null } } } },
        },
      },
    },
  });
  const seen = new Map<string, number>();
  for (const { group } of slots) {
    if (group._count.memberships > capacity) {
      seen.set(group.name, group._count.memberships);
    }
  }
  return [...seen].map(([group, count]) =>
    msg("rooms.warning.capacityBelowGroup", { group, count }),
  );
}

export async function createRoom(scope: Scope, input: RoomInput) {
  const { db, schoolId } = scope;
  await assertNameFree(db, input.name);
  try {
    const room = await db.room.create({
      data: { ...input, schoolId },
      select: { id: true, name: true },
    });
    await audit(scope, "room.created", "Room", room.id);
    return room;
  } catch (error) {
    if (isUniqueViolation(error))
      throw uniqueError("name", "rooms.field.name", input.name);
    throw error;
  }
}

export async function updateRoom(scope: Scope, id: string, input: RoomInput) {
  const { db } = scope;
  const existing = await db.room.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) throw notFound();
  await assertNameFree(db, input.name, id);
  try {
    const room = await db.room.update({
      where: { id },
      data: input,
      select: { id: true, name: true },
    });
    await audit(scope, "room.updated", "Room", id);
    return room;
  } catch (error) {
    if (isUniqueViolation(error))
      throw uniqueError("name", "rooms.field.name", input.name);
    throw error;
  }
}

async function findRoom(db: SchoolDb, id: string) {
  const room = await db.room.findUnique({
    where: { id },
    select: { id: true, name: true, archivedAt: true },
  });
  if (!room) throw notFound();
  return room;
}

/** How many slots still running use the room (archive confirm, §6.9). */
export function countActiveSlots(db: SchoolDb, roomId: string, today: Date) {
  return db.timetableSlot.count({
    where: { roomId, ...activeSlotWhere(today) },
  });
}

/** Always allowed; slots using it keep running (owner decision 5). */
export async function archiveRoom(scope: Scope, id: string) {
  const { db } = scope;
  const room = await findRoom(db, id);
  if (!room.archivedAt) {
    await db.room.update({ where: { id }, data: { archivedAt: new Date() } });
    await audit(scope, "room.archived", "Room", id);
  }
  return room;
}

export async function restoreRoom(scope: Scope, id: string) {
  const { db } = scope;
  const room = await findRoom(db, id);
  if (room.archivedAt) {
    await db.room.update({ where: { id }, data: { archivedAt: null } });
    await audit(scope, "room.restored", "Room", id);
  }
  return room;
}

/** Records that point at the room; delete is only allowed at zero. */
export async function roomUsage(db: SchoolDb, id: string) {
  const [slots, lessons] = await Promise.all([
    db.timetableSlot.count({ where: { roomId: id } }),
    db.lesson.count({ where: { roomId: id } }),
  ]);
  return slots + lessons;
}

export async function deleteRoom(scope: Scope, id: string) {
  const { db } = scope;
  const room = await findRoom(db, id);
  const usage = await roomUsage(db, id);
  if (usage > 0) {
    throw blockedError({
      title: msg("common.blocked.deleteTitle", { name: room.name }),
      reason: msg("common.inUse", { count: usage }),
    });
  }
  await db.room.delete({ where: { id } });
  await audit(scope, "room.deleted", "Room", id, { name: room.name });
  return room;
}
