// The per-school timetable lock, in its own module so services the timetable
// service calls into (replacements) can take it without an import cycle.

import type { Tx } from "./service";

/**
 * Serializes timetable changes per school, so two admins saving at once
 * cannot both pass the conflict check and double-book a teacher.
 */
export async function lockTimetable(tx: Tx, schoolId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${timetableLockKey(schoolId)}, 0))`;
}

/** Key of the per-school advisory lock every timetable change takes. */
export function timetableLockKey(schoolId: string): string {
  return `timetable:${schoolId}`;
}
