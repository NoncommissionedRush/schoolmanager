// Pure helpers for the read-only weekly timetable (docs/design/timetable.md
// §6): which week to show, who may see which lesson, what each role gets to
// see of it, and how the grid is laid out. No Prisma, no Next.js.

import {
  addDays,
  type IsoDate,
  isoWeekday,
  toZonedDateTime,
} from "@/server/scheduling";

/** A student's cancellation state for one of their lessons (absences.md §5.1). */
export type StudentAttendance = {
  /** Last instant a cancellation earns a credit. */
  cutoffAt: string;
  cutoffMinutes: number;
  /** "Valid until" of the credit a cancellation now would earn. */
  creditValidUntil: IsoDate;
  /** Their cancellation, if they (or the office) already cancelled. */
  cancelled: { at: string; byOffice: boolean; credit: boolean } | null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** Monday of the ISO week containing `date`. */
export function mondayOf(date: IsoDate): IsoDate {
  return addDays(date, 1 - isoWeekday(date));
}

/**
 * The Monday of the week to show: from `?week=` (any day of that week), or
 * the week containing `today` when the parameter is missing or invalid.
 */
export function resolveWeek(
  param: string | undefined,
  today: IsoDate,
): IsoDate {
  return mondayOf(param && isValidIsoDate(param) ? param : today);
}

/** A calendar date from a URL parameter, or `fallback`. */
export function parseIsoDateParam(
  param: string | undefined,
  fallback: IsoDate,
): IsoDate {
  return param && isValidIsoDate(param) ? param : fallback;
}

export type ViewerKind = "ADMIN" | "TEACHER" | "STUDENT";

/** Lesson as loaded from the database, before projection for a viewer. */
export type LessonRecord = {
  id: string;
  termId: string;
  timetableSlotId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
  cancelReason: string | null;
  group: {
    id: string;
    name: string;
    type: "GROUP" | "ONE_ON_ONE";
    level: { code: string };
  };
  teacher: { id: string; name: string };
  substitute: { id: string; name: string } | null;
  room: {
    id: string;
    name: string;
    kind: "PHYSICAL" | "ONLINE";
    meetingUrl: string | null;
  } | null;
  /** Students of the group on the lesson's date. */
  students: { id: string; name: string }[];
  /** Homework of a started lesson; loaded for students only. */
  homework?: string | null;
};

/**
 * How the signed-in teacher relates to a lesson: they teach it, they
 * substitute for someone, or someone covers their lesson.
 */
export type TeacherRole = "regular" | "substituting" | "covered";

/** What a viewer gets to see of a lesson. Never carries teacher notes. */
export type LessonView = {
  id: string;
  termId: string;
  slotId: string | null;
  date: IsoDate;
  startMinute: number;
  endMinute: number;
  startsAt: string;
  endsAt: string;
  status: LessonRecord["status"];
  cancelReason: string | null;
  group: { id: string; name: string; type: "GROUP" | "ONE_ON_ONE" };
  level: string;
  teacher: { id: string; name: string };
  substitute: { id: string; name: string } | null;
  room: {
    id: string;
    name: string;
    online: boolean;
    meetingUrl: string | null;
  } | null;
  /** Names of the students; null for students (they never see classmates). */
  students: { id: string; name: string }[] | null;
  /** Set for teacher viewers only. */
  teacherRole: TeacherRole | null;
  /** The lesson's homework, for students once it has started (lessons.md §5.1). */
  homework: string | null;
  /**
   * Students only: their cancellation and the lesson's cutoff
   * (absences.md §5.1). Filled in by the caller; null for staff.
   */
  attendance: StudentAttendance | null;
};

/** Projects a lesson for `viewer`; students never get other students' names. */
export function toLessonView(
  lesson: LessonRecord,
  viewer: { kind: ViewerKind; teacherId?: string },
  timeZone: string,
): LessonView {
  const start = toZonedDateTime(lesson.startsAt, timeZone);
  const end = toZonedDateTime(lesson.endsAt, timeZone);
  // A lesson that ends after midnight is drawn up to the end of its day.
  const endMinute = end.date === start.date ? end.minute : 24 * 60;
  let teacherRole: TeacherRole | null = null;
  if (viewer.kind === "TEACHER") {
    teacherRole =
      lesson.substitute?.id === viewer.teacherId
        ? "substituting"
        : lesson.substitute
          ? "covered"
          : "regular";
  }
  return {
    id: lesson.id,
    termId: lesson.termId,
    slotId: lesson.timetableSlotId,
    date: start.date,
    startMinute: start.minute,
    endMinute,
    startsAt: lesson.startsAt.toISOString(),
    endsAt: lesson.endsAt.toISOString(),
    status: lesson.status,
    cancelReason: lesson.cancelReason,
    group: {
      id: lesson.group.id,
      name: lesson.group.name,
      type: lesson.group.type,
    },
    level: lesson.group.level.code,
    teacher: lesson.teacher,
    substitute: lesson.substitute,
    room: lesson.room
      ? {
          id: lesson.room.id,
          name: lesson.room.name,
          online: lesson.room.kind === "ONLINE",
          meetingUrl: lesson.room.meetingUrl,
        }
      : null,
    students:
      viewer.kind === "STUDENT"
        ? null
        : [...lesson.students].sort((a, b) => a.name.localeCompare(b.name)),
    teacherRole,
    homework: viewer.kind === "STUDENT" ? (lesson.homework ?? null) : null,
    attendance: null,
  };
}

export type MembershipWindow = {
  groupId: string;
  joinedAt: Date;
  leftAt: Date | null;
};

/**
 * Whether a student with these memberships attends a lesson of `groupId`
 * starting at `startsAt`: only lessons on or after joining and before
 * leaving (timetable.md §10).
 */
export function isMemberAt(
  memberships: readonly MembershipWindow[],
  groupId: string,
  startsAt: Date,
): boolean {
  return memberships.some(
    (m) =>
      m.groupId === groupId &&
      m.joinedAt <= startsAt &&
      (m.leftAt === null || startsAt < m.leftAt),
  );
}

/** Students of a group at an instant, from its memberships. */
export function membersAt<T extends { joinedAt: Date; leftAt: Date | null }>(
  memberships: readonly T[],
  at: Date,
): T[] {
  return memberships.filter(
    (m) => m.joinedAt <= at && (m.leftAt === null || at < m.leftAt),
  );
}

// ---------------------------------------------------------------------------
// Grid layout
// ---------------------------------------------------------------------------

export type Block = { id: string; startMinute: number; endMinute: number };

export type PlacedBlock = { id: string; lane: number; lanes: number };

export type Overflow = {
  ids: string[];
  startMinute: number;
  endMinute: number;
  lane: number;
  lanes: number;
};

/** Up to this many blocks share a column side by side; the rest go into "+N more". */
export const MAX_LANES = 3;

/**
 * Lays out the blocks of one grid column: overlapping blocks split the
 * width (timetable.md §5.3, app-layout.md §7.5). With more than
 * `MAX_LANES` side by side, the last lane becomes a "+N more" overflow.
 * Back-to-back blocks (one ends when the next starts) don't overlap.
 */
export function layoutColumn(blocks: readonly Block[]): {
  placed: PlacedBlock[];
  overflow: Overflow[];
} {
  const sorted = [...blocks].sort(
    (a, b) =>
      a.startMinute - b.startMinute ||
      b.endMinute - a.endMinute ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const placed: PlacedBlock[] = [];
  const overflow: Overflow[] = [];
  let cluster: { block: Block; lane: number }[] = [];
  let clusterEnd = -1;
  let laneEnds: number[] = [];

  const flush = () => {
    if (cluster.length === 0) return;
    const lanes = laneEnds.length;
    if (lanes <= MAX_LANES) {
      for (const { block, lane } of cluster) {
        placed.push({ id: block.id, lane, lanes });
      }
    } else {
      const hidden = cluster.filter(({ lane }) => lane >= MAX_LANES - 1);
      for (const { block, lane } of cluster) {
        if (lane < MAX_LANES - 1) {
          placed.push({ id: block.id, lane, lanes: MAX_LANES });
        }
      }
      overflow.push({
        ids: hidden.map(({ block }) => block.id),
        startMinute: Math.min(...hidden.map(({ block }) => block.startMinute)),
        endMinute: Math.max(...hidden.map(({ block }) => block.endMinute)),
        lane: MAX_LANES - 1,
        lanes: MAX_LANES,
      });
    }
    cluster = [];
    laneEnds = [];
    clusterEnd = -1;
  };

  for (const block of sorted) {
    if (block.startMinute >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= block.startMinute);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(block.endMinute);
    } else {
      laneEnds[lane] = block.endMinute;
    }
    cluster.push({ block, lane });
    clusterEnd = Math.max(clusterEnd, block.endMinute);
  }
  flush();
  return { placed, overflow };
}

/**
 * Hours the grid shows: the school day, widened to whole hours so every
 * block fits (a slot outside school hours still has to be visible).
 */
export function gridHours(
  school: { dayStartMinute: number; dayEndMinute: number },
  blocks: readonly Pick<Block, "startMinute" | "endMinute">[],
): { startMinute: number; endMinute: number } {
  const start = Math.min(
    school.dayStartMinute,
    ...blocks.map((b) => b.startMinute),
  );
  const end = Math.max(school.dayEndMinute, ...blocks.map((b) => b.endMinute));
  return {
    startMinute: Math.floor(start / 60) * 60,
    endMinute: Math.min(24 * 60, Math.ceil(end / 60) * 60),
  };
}

/** ISO weekdays (1 = Monday) the grid shows: school days plus any day in use. */
export function gridWeekdays(
  teachingWeekdays: readonly number[],
  used: readonly number[],
): number[] {
  return [...new Set([...teachingWeekdays, ...used])]
    .filter((d) => d >= 1 && d <= 7)
    .sort((a, b) => a - b);
}
