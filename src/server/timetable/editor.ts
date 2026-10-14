// Pure helpers for the admin timetable editor (docs/design/timetable.md §5):
// which term and date to show, which slots are in effect, what each slot's
// issue badge is, and what the publish dialog summarises. No Prisma.

import {
  addDays,
  type Conflict,
  type IsoDate,
  isSlotInEffect,
  slotOccurrenceDates,
} from "@/server/scheduling";

export type TermSummary = {
  id: string;
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
  publishedAt: string | null;
};

/**
 * The term the editor opens: the one in the URL, else the current one,
 * else the next upcoming, else the newest (§5.1).
 */
export function pickTerm<T extends TermSummary>(
  terms: readonly T[],
  param: string | undefined,
  today: IsoDate,
): T | null {
  const byParam = param ? terms.find((t) => t.id === param) : undefined;
  if (byParam) return byParam;
  const current = terms.find((t) => t.startDate <= today && today <= t.endDate);
  if (current) return current;
  const upcoming = [...terms]
    .filter((t) => t.startDate > today)
    .sort((a, b) => (a.startDate < b.startDate ? -1 : 1))[0];
  if (upcoming) return upcoming;
  return (
    [...terms].sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0] ?? null
  );
}

/** Default "As of" date: today inside the term, else its first day (§5.1). */
export function defaultAsOf(
  term: Pick<TermSummary, "startDate" | "endDate">,
  today: IsoDate,
): IsoDate {
  return term.startDate <= today && today <= term.endDate
    ? today
    : term.startDate;
}

/** Clamps an "As of" date into the term. */
export function clampToTerm(
  date: IsoDate,
  term: Pick<TermSummary, "startDate" | "endDate">,
): IsoDate {
  if (date < term.startDate) return term.startDate;
  if (date > term.endDate) return term.endDate;
  return date;
}

type DatedSlot = { validFrom: IsoDate | null; validUntil: IsoDate | null };

/** Slots in effect on `asOf`; ended or not-yet-started ones are hidden. */
export function slotsAsOf<T extends DatedSlot>(
  slots: readonly T[],
  asOf: IsoDate,
): T[] {
  return slots.filter((slot) => isSlotInEffect(slot, asOf));
}

/** A previous override: which conflict keys an admin acknowledged, when. */
export type Acknowledgement = {
  keys: string[];
  actorName: string;
  at: string;
};

/**
 * Audit entries (`timetable_slot.created` / `.updated`) → the latest
 * acknowledgement per slot. A split edit is recorded on the old slot with
 * `newSlotId`; its acknowledgement belongs to the new slot.
 */
export function acknowledgementsFromAudit(
  entries: readonly {
    entityId: string;
    action: string;
    createdAt: Date;
    actorName: string;
    data: unknown;
  }[],
): Map<string, Acknowledgement> {
  const result = new Map<string, Acknowledgement>();
  const sorted = [...entries].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  for (const entry of sorted) {
    if (
      entry.action !== "timetable_slot.created" &&
      entry.action !== "timetable_slot.updated"
    ) {
      continue;
    }
    const data = (entry.data ?? {}) as {
      overridden?: { key?: unknown }[];
      newSlotId?: unknown;
    };
    const slotId =
      typeof data.newSlotId === "string" ? data.newSlotId : entry.entityId;
    const keys = (data.overridden ?? [])
      .map((c) => c.key)
      .filter((k): k is string => typeof k === "string");
    result.set(slotId, {
      keys,
      actorName: entry.actorName,
      at: entry.createdAt.toISOString(),
    });
  }
  return result;
}

/** Split edits: new slot id → the date the change took effect. */
export function splitDatesFromAudit(
  entries: readonly { action: string; data: unknown }[],
): Map<string, IsoDate> {
  const result = new Map<string, IsoDate>();
  for (const entry of entries) {
    if (entry.action !== "timetable_slot.updated") continue;
    const data = (entry.data ?? {}) as {
      newSlotId?: unknown;
      effectiveFrom?: unknown;
    };
    if (
      typeof data.newSlotId === "string" &&
      typeof data.effectiveFrom === "string"
    ) {
      result.set(data.newSlotId, data.effectiveFrom);
    }
  }
  return result;
}

/** "Changed on {date}" shows for 14 days after the change took effect (§5.5). */
export function showChangedOn(
  effectiveFrom: IsoDate | undefined,
  today: IsoDate,
): boolean {
  return (
    effectiveFrom !== undefined &&
    effectiveFrom <= today &&
    today < addDays(effectiveFrom, 14)
  );
}

export type SlotIssueState = "blocking" | "warning" | "acknowledged" | null;

/**
 * The badge a saved slot gets (§5.3): a blocking conflict, a warning nobody
 * acknowledged yet (it arose after saving), all warnings acknowledged, or
 * nothing.
 */
export function slotIssueState(
  conflicts: readonly Conflict[],
  acknowledgedKeys: readonly string[],
): SlotIssueState {
  if (conflicts.some((c) => c.severity === "blocking")) return "blocking";
  const acked = new Set(acknowledgedKeys);
  const warnings = conflicts.filter((c) => c.severity === "overridable");
  if (warnings.some((c) => !acked.has(c.key))) return "warning";
  return warnings.length > 0 ? "acknowledged" : null;
}

export type SlotIssue = {
  slotId: string;
  conflict: Conflict;
  acknowledged: boolean;
};

/**
 * Rows of the issues panel (§5.6): conflicts first, then warnings; with
 * `includeAcknowledged` also warnings that were already overridden.
 */
export function issueRows(
  bySlot: Record<string, Conflict[]>,
  acknowledged: (slotId: string) => readonly string[],
  includeAcknowledged: boolean,
): SlotIssue[] {
  const rows: SlotIssue[] = [];
  for (const [slotId, conflicts] of Object.entries(bySlot)) {
    const acked = new Set(acknowledged(slotId));
    for (const conflict of conflicts) {
      const isAcked =
        conflict.severity === "overridable" && acked.has(conflict.key);
      if (isAcked && !includeAcknowledged) continue;
      rows.push({ slotId, conflict, acknowledged: isAcked });
    }
  }
  const rank = (row: SlotIssue) =>
    row.conflict.severity === "blocking" ? 0 : row.acknowledged ? 2 : 1;
  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0) ||
      (a.conflict.key < b.conflict.key ? -1 : 1),
  );
}

export type PublishSummary = {
  slots: number;
  /** Lessons are created from the later of term start and today. */
  rangeStart: IsoDate;
  rangeEnd: IsoDate;
  /** Overridable conflicts (acknowledged or not); they never block. */
  warnings: number;
  /** Slots with at least one blocking conflict; publishing is refused. */
  blockingSlots: string[];
  blockingCount: number;
};

/** What the publish dialog shows (§5.7). */
export function publishSummary(
  term: Pick<TermSummary, "startDate" | "endDate">,
  slotCount: number,
  bySlot: Record<string, Conflict[]>,
  today: IsoDate,
): PublishSummary {
  let warnings = 0;
  let blockingCount = 0;
  const blockingSlots: string[] = [];
  for (const [slotId, conflicts] of Object.entries(bySlot)) {
    const blocking = conflicts.filter((c) => c.severity === "blocking").length;
    warnings += conflicts.length - blocking;
    blockingCount += blocking;
    if (blocking > 0) blockingSlots.push(slotId);
  }
  return {
    slots: slotCount,
    rangeStart: term.startDate > today ? term.startDate : today,
    rangeEnd: term.endDate,
    warnings,
    blockingSlots: blockingSlots.sort(),
    blockingCount,
  };
}

/**
 * "Runs" line of the slot sheet: how many lessons the slot produces in the
 * term and how many dates holidays skip (§3.2, §5.4).
 */
export function occurrenceSummary(
  slot: {
    weekday: number;
    validFrom: IsoDate | null;
    validUntil: IsoDate | null;
  },
  term: { startDate: IsoDate; endDate: IsoDate },
  holidays: readonly { startDate: IsoDate; endDate: IsoDate }[],
): {
  count: number;
  skipped: number;
  first: IsoDate | null;
  last: IsoDate | null;
} {
  const all = slotOccurrenceDates(slot, term, []);
  const dates = slotOccurrenceDates(slot, term, holidays);
  return {
    count: dates.length,
    skipped: all.length - dates.length,
    first: dates[0] ?? null,
    last: dates.at(-1) ?? null,
  };
}

/** Teacher of the group's other slots in this term, to prefill the sheet (§5.4). */
export function defaultTeacherForGroup(
  slots: readonly { groupId: string; teacherId: string }[],
  groupId: string,
): string | null {
  const counts = new Map<string, number>();
  for (const slot of slots) {
    if (slot.groupId !== groupId) continue;
    counts.set(slot.teacherId, (counts.get(slot.teacherId) ?? 0) + 1);
  }
  let best: string | null = null;
  let max = 0;
  for (const [teacherId, n] of counts) {
    if (n > max || (n === max && best !== null && teacherId < best)) {
      best = teacherId;
      max = n;
    }
  }
  return best;
}

/**
 * Default last lesson in the End dialog (§5.5): the last occurrence on or
 * before today + 7 days, never before today; null if none is left.
 */
export function defaultEndDate(
  slot: {
    weekday: number;
    validFrom: IsoDate | null;
    validUntil: IsoDate | null;
  },
  term: { startDate: IsoDate; endDate: IsoDate },
  today: IsoDate,
): IsoDate {
  const horizon = addDays(today, 7);
  const dates = slotOccurrenceDates(slot, term, []).filter(
    (d) => d >= today && d <= horizon,
  );
  return dates.at(-1) ?? today;
}

/**
 * Earliest last lesson the End dialog offers. Mirrors `endSlot`: a slot of a
 * published term may end yesterday at the earliest; draft terms have no
 * lower bound.
 */
export function earliestEndDate(
  today: IsoDate,
  published: boolean,
): IsoDate | undefined {
  return published ? addDays(today, -1) : undefined;
}

/**
 * Whether the slot sheet may save (§5.4): only once the live check has
 * answered for exactly the draft on screen, so a save never goes out on a
 * result that is still running, debouncing, or for an older draft. An
 * incomplete draft may "save" so the sheet can say what is missing.
 */
export function canSaveSlot({
  complete,
  checking,
  pending,
  checkedKey,
  requestKey,
}: {
  complete: boolean;
  checking: boolean;
  pending: boolean;
  checkedKey: string | null;
  requestKey: string;
}): boolean {
  if (pending) return false;
  if (!complete) return true;
  return !checking && checkedKey === requestKey;
}
