import { type Message, msg } from "../result";

/**
 * Pure membership and capacity rules for groups (§6.10). The services load
 * the data and call these; they never touch the database themselves.
 */

/** Free places in a group; never negative (an overfilled group has 0). */
export function placesLeft(capacity: number, activeMembers: number): number {
  return Math.max(0, capacity - activeMembers);
}

export function isFull(capacity: number, activeMembers: number): boolean {
  return placesLeft(capacity, activeMembers) === 0;
}

/**
 * Lowering the capacity below the current member count is refused
 * (`groups.error.capacityBelowMembers`).
 */
export function capacityError(
  capacity: number,
  activeMembers: number,
): Message | null {
  return capacity < activeMembers
    ? msg("groups.error.capacityBelowMembers", { count: activeMembers })
    : null;
}

/** The type is fixed once lessons exist for the group. */
export function canChangeType(lessonCount: number): boolean {
  return lessonCount === 0;
}

export type ExistingMembership = {
  id: string;
  studentId: string;
  leftAt: Date | null;
};

export type AddMembersPlan =
  | {
      ok: true;
      /** Students with no row for this group yet. */
      create: string[];
      /** Former members: their row is reused (unique group + student). */
      rejoin: { membershipId: string; studentId: string }[];
    }
  | { ok: false; error: Message };

/**
 * Decides how to add `requested` students to a group: never overfill, and
 * reuse the row of a former member (the table is unique per group and
 * student). Current members can't be added twice.
 */
export function planAddMembers({
  capacity,
  existing,
  requested,
}: {
  capacity: number;
  existing: ExistingMembership[];
  requested: string[];
}): AddMembersPlan {
  const unique = [...new Set(requested)];
  if (unique.length === 0) {
    return { ok: false, error: msg("groups.members.noneSelected") };
  }
  const byStudent = new Map(existing.map((row) => [row.studentId, row]));
  const active = existing.filter((row) => row.leftAt === null).length;
  if (unique.some((studentId) => byStudent.get(studentId)?.leftAt === null)) {
    return { ok: false, error: msg("groups.members.alreadyMember") };
  }
  if (unique.length > placesLeft(capacity, active)) {
    return { ok: false, error: msg("groups.members.full") };
  }
  const create: string[] = [];
  const rejoin: { membershipId: string; studentId: string }[] = [];
  for (const studentId of unique) {
    const row = byStudent.get(studentId);
    if (row) rejoin.push({ membershipId: row.id, studentId });
    else create.push(studentId);
  }
  return { ok: true, create, rejoin };
}

/**
 * Removing a member sets `leftAt` ("Last day in the group"). The date must
 * be on or after the day they joined and not in the future, because a
 * member with `leftAt` set no longer counts towards the group.
 */
export function removalError({
  joinedAt,
  leftAt,
  date,
  today,
}: {
  joinedAt: Date;
  leftAt: Date | null;
  date: Date;
  today: Date;
}): Message | null {
  if (leftAt !== null) return msg("groups.members.notMember");
  if (date.getTime() < startOfUtcDay(joinedAt).getTime()) {
    return msg("groups.members.leftBeforeJoined");
  }
  if (date.getTime() > today.getTime()) {
    return msg("groups.members.leftInFuture");
  }
  return null;
}

const startOfUtcDay = (date: Date) =>
  new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );

/**
 * A student of another level may join (admin decides) but gets a warning
 * tag. Students without a level get no tag.
 */
export function levelMismatch(
  studentLevelId: string | null,
  groupLevelId: string,
): boolean {
  return studentLevelId !== null && studentLevelId !== groupLevelId;
}

/**
 * Profile warning `students.levelMismatch`: the current groups whose level
 * differs from the level being saved.
 */
export function groupsOfOtherLevel<
  G extends { name: string; levelId: string; levelCode: string },
>(levelId: string | null, groups: G[]): G[] {
  if (levelId === null) return [];
  return groups.filter((group) => group.levelId !== levelId);
}

export type SlotTime = {
  termId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
};

export function slotsOverlap(a: SlotTime, b: SlotTime): boolean {
  return (
    a.termId === b.termId &&
    a.weekday === b.weekday &&
    a.startMinute < b.endMinute &&
    b.startMinute < a.endMinute
  );
}

/** Name of the first other group whose slot overlaps one of this group's. */
export function timeClash(
  groupSlots: SlotTime[],
  otherSlots: (SlotTime & { groupName: string })[],
): string | null {
  for (const other of otherSlots) {
    if (groupSlots.some((slot) => slotsOverlap(slot, other))) {
      return other.groupName;
    }
  }
  return null;
}

/**
 * Archived records are hidden from pickers, except the value a form already
 * points at (§5.3 "Exception: the current value").
 */
export function pickable<T extends { id: string; archivedAt: Date | null }>(
  items: T[],
  currentId?: string | null,
): T[] {
  return items.filter(
    (item) => item.archivedAt === null || item.id === currentId,
  );
}

/** A group as offered by the "Add to group" pickers. */
export type GroupOption = {
  id: string;
  name: string;
  capacity: number;
  levelId: string;
  levelCode: string;
  members: number;
};

/**
 * Groups a student can join: free places, not already theirs and — unless
 * `showAll` or the student has no level — of the student's level (§6.6).
 */
export function joinableGroups<G extends GroupOption>(
  groups: G[],
  {
    levelId,
    exclude = [],
    showAll,
  }: { levelId: string | null; exclude?: string[]; showAll: boolean },
): G[] {
  return groups.filter(
    (group) =>
      !exclude.includes(group.id) &&
      !isFull(group.capacity, group.members) &&
      (showAll || !levelId || group.levelId === levelId),
  );
}
