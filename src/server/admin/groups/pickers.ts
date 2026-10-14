import { AdminError, msg } from "../result";
import type { SchoolDb } from "../shared";

/**
 * Server checks behind the level / course / group pickers (§5.3, §5.5):
 * archived records can't be picked, except the value the record already
 * has.
 */

export async function assertLevelPickable(
  db: SchoolDb,
  levelId: string,
  field: string,
  currentId?: string | null,
) {
  const level = await db.level.findUnique({
    where: { id: levelId },
    select: { id: true, archivedAt: true },
  });
  if (!level || (level.archivedAt && level.id !== currentId)) {
    throw new AdminError(msg("groups.error.archivedChoice"), field);
  }
  return level;
}

/** Levels for a picker: active ones plus the current value. */
export function levelOptions(db: SchoolDb) {
  return db.level.findMany({
    orderBy: { rank: "asc" },
    select: { id: true, code: true, name: true, archivedAt: true },
  });
}
