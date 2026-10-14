import type { SchoolDb } from "./shared";

/** What the setup checklist (§3.1) is computed from. */
export type SetupCounts = {
  terms: number;
  rooms: number;
  levels: number;
  teachers: number;
  students: number;
  /** Groups with at least one current member. */
  groupsWithMembers: number;
  /** Terms whose timetable is published. */
  publishedTerms: number;
};

export type SetupStepKey =
  | "term"
  | "rooms"
  | "levels"
  | "teachers"
  | "students"
  | "groups"
  | "timetable";

export type SetupStep = { key: SetupStepKey; href: string; done: boolean };

const STEPS: {
  key: SetupStepKey;
  href: string;
  done: (counts: SetupCounts) => boolean;
}[] = [
  { key: "term", href: "/admin/settings/terms", done: (c) => c.terms > 0 },
  { key: "rooms", href: "/admin/settings/rooms", done: (c) => c.rooms > 0 },
  { key: "levels", href: "/admin/levels", done: (c) => c.levels > 0 },
  { key: "teachers", href: "/admin/teachers", done: (c) => c.teachers > 0 },
  { key: "students", href: "/admin/students", done: (c) => c.students > 0 },
  {
    key: "groups",
    href: "/admin/groups",
    done: (c) => c.groupsWithMembers > 0,
  },
  {
    key: "timetable",
    href: "/admin/timetable",
    done: (c) => c.publishedTerms > 0,
  },
];

/**
 * The 7 setup steps in order, how many are done, and whether the checklist
 * is complete (then the dashboard shows its normal content). Steps aren't
 * locked: any order works.
 */
export function setupChecklist(counts: SetupCounts) {
  const steps: SetupStep[] = STEPS.map(({ key, href, done }) => ({
    key,
    href,
    done: done(counts),
  }));
  const done = steps.filter((step) => step.done).length;
  return { steps, done, total: steps.length, complete: done === steps.length };
}

/** Counts for the checklist; archived records don't count. */
export async function loadSetupCounts(db: SchoolDb): Promise<SetupCounts> {
  const [
    terms,
    rooms,
    levels,
    teachers,
    students,
    groupsWithMembers,
    publishedTerms,
  ] = await Promise.all([
    db.term.count(),
    db.room.count({ where: { archivedAt: null } }),
    db.level.count({ where: { archivedAt: null } }),
    db.membership.count({
      where: { role: "TEACHER", user: { deletedAt: null } },
    }),
    db.membership.count({
      where: { role: "STUDENT", user: { deletedAt: null } },
    }),
    db.group.count({
      where: { deletedAt: null, memberships: { some: { leftAt: null } } },
    }),
    db.term.count({ where: { timetablePublishedAt: { not: null } } }),
  ]);
  return {
    terms,
    rooms,
    levels,
    teachers,
    students,
    groupsWithMembers,
    publishedTerms,
  };
}
