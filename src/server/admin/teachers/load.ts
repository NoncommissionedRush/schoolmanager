/**
 * Pure helpers for the teacher list and detail (§6.1, §6.3): which term is
 * "current", and a teacher's load from their timetable slots.
 */

export type TermDates = { id: string; startDate: Date; endDate: Date };

/**
 * The term running on `today`; else the next one to start; else the one
 * that ended last. Null when there are no terms.
 */
export function pickCurrentTerm<T extends TermDates>(
  terms: readonly T[],
  today: Date,
): T | null {
  const time = today.getTime();
  const running = terms.find(
    (term) =>
      term.startDate.getTime() <= time && time <= term.endDate.getTime(),
  );
  if (running) return running;
  const upcoming = terms
    .filter((term) => term.startDate.getTime() > time)
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  if (upcoming[0]) return upcoming[0];
  const past = [...terms].sort(
    (a, b) => b.endDate.getTime() - a.endDate.getTime(),
  );
  return past[0] ?? null;
}

export type LoadSlot = {
  teacherId: string;
  groupId: string;
  termId: string;
  validFrom: Date | null;
  validUntil: Date | null;
};

/**
 * Per teacher: distinct groups across the given (still running) slots, and
 * lessons per week = slots of the current term valid on the reference day
 * (today, or the term's first day when it hasn't started), so a slot that
 * moves mid-term isn't counted twice.
 */
export function teacherLoad(
  slots: readonly LoadSlot[],
  currentTerm: TermDates | null,
  today: Date,
): Map<string, { groups: number; lessonsPerWeek: number }> {
  const reference =
    currentTerm && currentTerm.startDate > today
      ? currentTerm.startDate
      : today;
  const groups = new Map<string, Set<string>>();
  const weekly = new Map<string, number>();
  for (const slot of slots) {
    if (!groups.has(slot.teacherId)) groups.set(slot.teacherId, new Set());
    groups.get(slot.teacherId)!.add(slot.groupId);
    const valid =
      slot.termId === currentTerm?.id &&
      (slot.validFrom === null || slot.validFrom <= reference) &&
      (slot.validUntil === null || slot.validUntil >= reference);
    if (valid)
      weekly.set(slot.teacherId, (weekly.get(slot.teacherId) ?? 0) + 1);
  }
  const result = new Map<string, { groups: number; lessonsPerWeek: number }>();
  for (const [teacherId, set] of groups) {
    result.set(teacherId, {
      groups: set.size,
      lessonsPerWeek: weekly.get(teacherId) ?? 0,
    });
  }
  return result;
}
