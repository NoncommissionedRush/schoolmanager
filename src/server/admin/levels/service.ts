import type { StatusFilter } from "../list";
import { AdminError, blockedError, msg } from "../result";
import {
  audit,
  isUniqueViolation,
  notFound,
  type SchoolDb,
  type Scope,
} from "../shared";
import {
  type CefrCode,
  cefrPreset,
  type MoveDirection,
  moveTarget,
  nextRank,
  planMove,
} from "./order";
import type { LevelInput } from "./schema";

/** Students and groups that still have the level (archive confirm, §6.7). */
const usageCounts = {
  students: { where: { user: { deletedAt: null } } },
  groups: { where: { deletedAt: null } },
} as const;

/**
 * Every level in rank order (not paginated, §6.7). `position` is the place
 * in the full order, so archived levels show where they sit.
 */
export async function listLevels(db: SchoolDb, status: StatusFilter) {
  const all = await db.level.findMany({
    orderBy: { rank: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      rank: true,
      archivedAt: true,
      _count: {
        select: {
          students: usageCounts.students,
          groups: usageCounts.groups,
        },
      },
    },
  });
  const ranked = all.map((l) => ({
    id: l.id,
    rank: l.rank,
    archived: !!l.archivedAt,
  }));
  const usage = await levelUsageMap(
    db,
    all.map((l) => l.id),
  );
  const levels = all.map(({ _count, ...level }, index) => ({
    ...level,
    position: index + 1,
    students: _count.students,
    groups: _count.groups,
    usage: usage.get(level.id) ?? 0,
    canMoveUp: !!moveTarget(ranked, level.id, "up"),
    canMoveDown: !!moveTarget(ranked, level.id, "down"),
  }));
  // Filtered in memory: positions and move targets need the full order.
  const visible =
    status === "all"
      ? levels
      : levels.filter((l) => (status === "active") === !l.archivedAt);
  return {
    levels: visible,
    activeCount: levels.filter((l) => !l.archivedAt).length,
    anyCount: levels.length,
  };
}

/** Records pointing at each level (any state); delete only at zero. */
async function levelUsageMap(db: SchoolDb, ids: string[]) {
  const rows = await db.level.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      _count: { select: { students: true, groups: true, courses: true } },
    },
  });
  return new Map(
    rows.map((r) => [
      r.id,
      r._count.students + r._count.groups + r._count.courses,
    ]),
  );
}

function codeTaken(code: string) {
  return new AdminError(msg("levels.error.codeTaken", { code }), "code");
}

async function assertCodeFree(db: SchoolDb, code: string, exceptId?: string) {
  const clash = await db.level.findFirst({
    where: {
      code: { equals: code, mode: "insensitive" },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw codeTaken(code);
}

/** New levels go last (§6.7). */
export async function createLevel(scope: Scope, input: LevelInput) {
  const { db, schoolId } = scope;
  await assertCodeFree(db, input.code);
  const existing = await db.level.findMany({ select: { rank: true } });
  try {
    const level = await db.level.create({
      data: { ...input, rank: nextRank(existing), schoolId },
      select: { id: true, code: true },
    });
    await audit(scope, "level.created", "Level", level.id);
    return level;
  } catch (error) {
    if (isUniqueViolation(error)) throw codeTaken(input.code);
    throw error;
  }
}

export async function updateLevel(scope: Scope, id: string, input: LevelInput) {
  const { db } = scope;
  await findLevel(db, id);
  await assertCodeFree(db, input.code, id);
  try {
    const level = await db.level.update({
      where: { id },
      data: input,
      select: { id: true, code: true },
    });
    await audit(scope, "level.updated", "Level", id);
    return level;
  } catch (error) {
    if (isUniqueViolation(error)) throw codeTaken(input.code);
    throw error;
  }
}

async function findLevel(db: SchoolDb, id: string) {
  const level = await db.level.findUnique({
    where: { id },
    select: { id: true, code: true, archivedAt: true },
  });
  if (!level) throw notFound();
  return level;
}

/**
 * Move up / down: swaps ranks with the nearest active level in one
 * transaction, through a temporary rank (unique `(schoolId, rank)`, §9).
 */
export async function moveLevel(
  scope: Scope,
  id: string,
  direction: MoveDirection,
) {
  const level = await scope.db.$transaction(async (tx) => {
    const levels = await tx.level.findMany({
      select: { id: true, code: true, rank: true, archivedAt: true },
    });
    const level = levels.find((l) => l.id === id);
    if (!level) throw notFound();
    const plan = planMove(
      levels.map((l) => ({ id: l.id, rank: l.rank, archived: !!l.archivedAt })),
      id,
      direction,
    );
    for (const update of plan) {
      await tx.level.update({
        where: { id: update.id },
        data: { rank: update.rank },
      });
    }
    return { ...level, moved: plan.length > 0 };
  });
  if (level.moved) {
    await audit(scope, "level.moved", "Level", id, { direction });
  }
  return level;
}

/** Adds the CEFR levels A1–C2 that don't exist yet (empty state, §6.7). */
export async function addCefrPreset(
  scope: Scope,
  names: Record<CefrCode, string>,
) {
  const { schoolId } = scope;
  const created = await scope.db.$transaction(async (tx) => {
    const existing = await tx.level.findMany({
      select: { code: true, rank: true },
    });
    const preset = cefrPreset(existing, names);
    for (const level of preset) {
      await tx.level.create({ data: { ...level, schoolId } });
    }
    return preset.length;
  });
  if (created > 0) {
    await audit(scope, "level.preset_added", "School", schoolId, {
      preset: "CEFR",
      created,
    });
  }
  return created;
}

/** Always allowed; students and groups keep the level (§6.7). */
export async function archiveLevel(scope: Scope, id: string) {
  const { db } = scope;
  const level = await findLevel(db, id);
  if (!level.archivedAt) {
    await db.level.update({ where: { id }, data: { archivedAt: new Date() } });
    await audit(scope, "level.archived", "Level", id);
  }
  return level;
}

export async function restoreLevel(scope: Scope, id: string) {
  const { db } = scope;
  const level = await findLevel(db, id);
  if (level.archivedAt) {
    await db.level.update({ where: { id }, data: { archivedAt: null } });
    await audit(scope, "level.restored", "Level", id);
  }
  return level;
}

/** Only while no student, group or course uses it (§5.3). */
export async function deleteLevel(scope: Scope, id: string) {
  const { db } = scope;
  const level = await findLevel(db, id);
  const usage = (await levelUsageMap(db, [id])).get(id) ?? 0;
  if (usage > 0) {
    throw blockedError({
      title: msg("common.blocked.deleteTitle", { name: level.code }),
      reason: msg("common.inUse", { count: usage }),
    });
  }
  await db.level.delete({ where: { id } });
  await audit(scope, "level.deleted", "Level", id, { code: level.code });
  return level;
}
