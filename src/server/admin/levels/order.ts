/**
 * Pure helpers for level ordering (§6.7, §9). Levels are ordered by `rank`,
 * which is unique per school, so swapping two ranks needs a temporary rank
 * in between. Archived levels keep their rank and are skipped by Move up /
 * Move down.
 */

export type RankedLevel = { id: string; rank: number; archived: boolean };
export type RankUpdate = { id: string; rank: number };
export type MoveDirection = "up" | "down";

/** Rank for a new level: after every existing one (archived included). */
export function nextRank(levels: { rank: number }[]): number {
  return levels.reduce((max, level) => Math.max(max, level.rank), 0) + 1;
}

/** The active level `id` would swap with, or null at the edge / if archived. */
export function moveTarget(
  levels: RankedLevel[],
  id: string,
  direction: MoveDirection,
): RankedLevel | null {
  const level = levels.find((l) => l.id === id);
  if (!level || level.archived) return null;
  const active = levels
    .filter((l) => !l.archived)
    .sort((a, b) => a.rank - b.rank);
  const index = active.findIndex((l) => l.id === id);
  return active[index + (direction === "up" ? -1 : 1)] ?? null;
}

/**
 * Updates (applied in order, in one transaction) that swap `id` with its
 * nearest active neighbour. Empty when there is nothing to swap with.
 */
export function planMove(
  levels: RankedLevel[],
  id: string,
  direction: MoveDirection,
): RankUpdate[] {
  const level = levels.find((l) => l.id === id);
  const other = moveTarget(levels, id, direction);
  if (!level || !other) return [];
  // Below every rank in use, so it can't collide with @@unique([schoolId, rank]).
  const temporary = Math.min(0, ...levels.map((l) => l.rank)) - 1;
  return [
    { id: level.id, rank: temporary },
    { id: other.id, rank: level.rank },
    { id: level.id, rank: other.rank },
  ];
}

export const CEFR_CODES = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type CefrCode = (typeof CEFR_CODES)[number];

/**
 * The CEFR preset (A1–C2) for the empty state, after any existing levels.
 * Codes that already exist (case-insensitive) are skipped.
 */
export function cefrPreset(
  existing: { code: string; rank: number }[],
  names: Record<CefrCode, string>,
): { code: string; name: string; rank: number }[] {
  const taken = new Set(existing.map((l) => l.code.toLowerCase()));
  let rank = nextRank(existing);
  return CEFR_CODES.filter((code) => !taken.has(code.toLowerCase())).map(
    (code) => ({ code, name: names[code], rank: rank++ }),
  );
}
