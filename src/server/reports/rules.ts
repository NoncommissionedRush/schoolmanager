// Reports: the pure rules (docs/architecture/phase6-rules.md §2–§4). What
// the attendance and teacher-hours reports count, the period and row
// limits, and rounding. Plain data in, deterministic sorted output, no
// Prisma, no Next.js, no `Date.now()` and no floating point for counts,
// rates or hours: the service passes `now` and the school's time zone.

import {
  addDays,
  daysBetween,
  formatMinutes,
  fromIsoDate,
  type IsoDate,
  lessonMinutes,
  STUDENT_CANCELLED,
  teachingMinutes,
  toIsoDate,
  toZonedDateTime,
  zonedTimeToUtc,
} from "@/server/scheduling";
import { isMemberAt, type MembershipWindow } from "@/server/timetable/week";

/** Longest period, counted inclusively (§2). */
export const REPORT_MAX_RANGE_DAYS = 366;
/** Most data rows in one CSV (§2). */
export const REPORT_MAX_ROWS = 50_000;
/** Rows per page on the report pages (§2). */
export const REPORT_PAGE_SIZE = 50;
/** `isMakeupLesson` gives up after this many steps (§3.2). */
export const MAKEUP_CHAIN_MAX = 50;

export const REPORTS = [
  "attendance",
  "teacher-hours",
  "teacher-hours-lessons",
] as const;
export type ReportKind = (typeof REPORTS)[number];

export const REPORT_ERROR_CODES = [
  "RANGE_TOO_LONG",
  "INVALID_RANGE",
  "TOO_MANY_ROWS",
  "NOT_FOUND",
  "NO_TERM",
  "CHAIN_TOO_LONG",
] as const;
export type ReportErrorCode = (typeof REPORT_ERROR_CODES)[number];

export class ReportError extends Error {
  constructor(
    readonly code: ReportErrorCode,
    /** `TOO_MANY_ROWS`: the rows the export would have. */
    readonly count?: number,
  ) {
    super(code);
    this.name = "ReportError";
  }
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/** ⌊(2a + b) / (2b)⌋: a / b rounded half up, for a ≥ 0, b > 0 (§3.3). */
export function roundHalfUpDiv(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b));
}

/** Minutes as decimal hours with two places, half up: 750 → "12.50" (§4.1). */
export function minutesToHours(minutes: number): string {
  const hundredths = roundHalfUpDiv(minutes * 100, 60);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`;
}

/** Attendance in tenths of a percent, null when nothing was expected. */
export function attendanceRate(attended: number, expected: number) {
  return expected === 0 ? null : roundHalfUpDiv(attended * 1000, expected);
}

/** Tenths of a percent as "87.5"; "" for no rate (the CSV value). */
export function formatRate(tenths: number | null): string {
  return tenths === null ? "" : `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

// ---------------------------------------------------------------------------
// Period (§2)
// ---------------------------------------------------------------------------

export type ReportTerm = {
  id: string;
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
};

export type Period = { termId: string | null; from: IsoDate; to: IsoDate };

/** The term running today, else the latest that started, else the first. */
export function defaultTerm<T extends ReportTerm>(
  terms: readonly T[],
  today: IsoDate,
): T | null {
  const sorted = [...terms].sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id),
  );
  return (
    sorted.find((t) => t.startDate <= today && today <= t.endDate) ??
    sorted.filter((t) => t.startDate <= today).at(-1) ??
    sorted[0] ??
    null
  );
}

/**
 * The period of a report: custom `from` / `to` when given, else the term
 * (`termId`, else the default term). `NO_TERM` without terms (and no custom
 * dates), `NOT_FOUND` for an unknown term, `INVALID_RANGE` /
 * `RANGE_TOO_LONG` for a bad custom period.
 */
export function resolvePeriod(
  input: { termId?: string; from?: IsoDate; to?: IsoDate },
  terms: readonly ReportTerm[],
  today: IsoDate,
): Period {
  if (input.from !== undefined || input.to !== undefined) {
    if (input.from === undefined || input.to === undefined) {
      throw new ReportError("INVALID_RANGE");
    }
    checkRange(input.from, input.to);
    return { termId: null, from: input.from, to: input.to };
  }
  const term = input.termId
    ? terms.find((t) => t.id === input.termId)
    : defaultTerm(terms, today);
  if (input.termId && !term) throw new ReportError("NOT_FOUND");
  if (!term) throw new ReportError("NO_TERM");
  checkRange(term.startDate, term.endDate);
  return { termId: term.id, from: term.startDate, to: term.endDate };
}

/** A real calendar date written `YYYY-MM-DD`. */
export const isIsoDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && toIsoDate(fromIsoDate(value)) === value;

/**
 * Two valid dates with `from ≤ to` (`INVALID_RANGE`), at most
 * `REPORT_MAX_RANGE_DAYS` days inclusive (`RANGE_TOO_LONG`).
 */
export function checkRange(from: IsoDate, to: IsoDate): void {
  if (!isIsoDate(from) || !isIsoDate(to)) {
    throw new ReportError("INVALID_RANGE");
  }
  const days = daysBetween(from, to) + 1;
  if (days < 1) throw new ReportError("INVALID_RANGE");
  if (days > REPORT_MAX_RANGE_DAYS) throw new ReportError("RANGE_TOO_LONG");
}

/** `[from 00:00, to + 1 00:00)` in the school's time zone. */
export function periodInstants(
  period: { from: IsoDate; to: IsoDate },
  timeZone: string,
): { from: Date; to: Date } {
  return {
    from: zonedTimeToUtc(period.from, 0, timeZone),
    to: zonedTimeToUtc(addDays(period.to, 1), 0, timeZone),
  };
}

/** The period reaches past `now`, so only lessons until now count. */
export const reachesPastNow = (range: { to: Date }, now: Date) =>
  range.to.getTime() > now.getTime();

/** `TOO_MANY_ROWS` with the count when a CSV would exceed the limit. */
export function checkRowLimit(rows: number): void {
  if (rows > REPORT_MAX_ROWS) throw new ReportError("TOO_MANY_ROWS", rows);
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

export type ReportLesson = {
  id: string;
  termId: string;
  groupId: string;
  teacherId: string;
  substituteTeacherId: string | null;
  roomId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
  cancelReason: string | null;
  rescheduledFromId: string | null;
};

export const effectiveTeacher = (
  lesson: Pick<ReportLesson, "teacherId" | "substituteTeacherId">,
) => lesson.substituteTeacherId ?? lesson.teacherId;

const hasEnded = (lesson: ReportLesson, now: Date) =>
  lesson.endsAt.getTime() <= now.getTime();

const startsIn = (lesson: ReportLesson, range: { from: Date; to: Date }) =>
  lesson.startsAt.getTime() >= range.from.getTime() &&
  lesson.startsAt.getTime() < range.to.getTime();

const byStart = (a: ReportLesson, b: ReportLesson) =>
  a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id);

/**
 * §3.2: whether `lesson` is a makeup, i.e. bought with a credit the student
 * earned by cancelling a lesson. Follows the reschedule chain through
 * `lessons` (which must hold every ancestor): a `STUDENT_CANCELLED` parent
 * makes it a makeup; any other parent (an admin move, a slot split) passes
 * its own role on. Gives up with `CHAIN_TOO_LONG` after 50 steps.
 */
export function isMakeupLesson(
  lesson: Pick<ReportLesson, "rescheduledFromId">,
  lessons: ReadonlyMap<
    string,
    Pick<ReportLesson, "rescheduledFromId" | "cancelReason">
  >,
): boolean {
  let current = lesson;
  for (let step = 0; step < MAKEUP_CHAIN_MAX; step++) {
    if (current.rescheduledFromId === null) return false;
    const parent = lessons.get(current.rescheduledFromId);
    // The loader loads every ancestor; a missing one can't have been a
    // credit-earning cancellation we know of.
    if (!parent) return false;
    if (parent.cancelReason === STUDENT_CANCELLED) return true;
    // RESCHEDULED (an admin move) and anything else inherit the parent's role.
    current = parent;
  }
  throw new ReportError("CHAIN_TOO_LONG");
}

export type ReportMembership = MembershipWindow & { studentId: string };

export type ReportAbsence = {
  lessonId: string;
  studentId: string;
  /** The report has a `MakeupCredit` (any state). */
  hasCredit: boolean;
};

/**
 * §3.2 `expectedFor(s, L)`, for lessons of published terms (the loader only
 * loads those): `s` is a member of the group when `L` starts, `L` isn't
 * cancelled — unless the student cancelled it themselves
 * (`STUDENT_CANCELLED` with their absence report) — and isn't a makeup.
 */
export function expectedFor(
  memberships: readonly MembershipWindow[],
  lesson: ReportLesson,
  absent: boolean,
  makeup: boolean,
): boolean {
  if (!isMemberAt(memberships, lesson.groupId, lesson.startsAt)) return false;
  if (
    lesson.status === "CANCELLED" &&
    !(lesson.cancelReason === STUDENT_CANCELLED && absent)
  ) {
    return false;
  }
  return !makeup;
}

// ---------------------------------------------------------------------------
// Attendance (§3)
// ---------------------------------------------------------------------------

export type ReportGroup = {
  id: string;
  name: string;
  type: "GROUP" | "ONE_ON_ONE";
  levelCode: string;
  archived: boolean;
};

export type ReportPerson = { id: string; name: string; archived: boolean };

export type ReportReplacement = {
  studentId: string;
  targetLessonId: string;
  /** Group of the booking's original (missed) lesson: the row it counts in. */
  originalGroupId: string;
  status: string;
};

/** Replacement states that hold a seat (replacements.md §6). */
export const ACTIVE_REPLACEMENT_STATUSES = [
  "AUTO_APPROVED",
  "APPROVED",
  "OVERRIDDEN",
] as const;

export type AttendanceFilters = {
  groupId?: string;
  /** The lesson's (or makeup's) effective teacher. */
  teacherId?: string;
  studentId?: string;
};

export type AttendanceInput = {
  /** Lessons of published terms starting in the period (any status). */
  lessons: readonly ReportLesson[];
  /** Every lesson by id, the period's and their reschedule ancestors. */
  chain: ReadonlyMap<string, ReportLesson>;
  memberships: readonly ReportMembership[];
  absences: readonly ReportAbsence[];
  replacements: readonly ReportReplacement[];
  groups: ReadonlyMap<string, ReportGroup>;
  students: ReadonlyMap<string, ReportPerson>;
  range: { from: Date; to: Date };
  now: Date;
  filters: AttendanceFilters;
};

export type AttendanceCounts = {
  expected: number;
  absent: number;
  absentWithCredit: number;
  absentLate: number;
  attended: number;
  /** Tenths of a percent; null when `expected` is 0. */
  attendanceRate: number | null;
  makeupsAttended: number;
};

export type AttendanceRow = AttendanceCounts & {
  studentId: string;
  studentName: string;
  studentArchived: boolean;
  groupId: string;
  groupName: string;
  groupType: "GROUP" | "ONE_ON_ONE";
  levelCode: string;
  groupArchived: boolean;
};

export type AttendanceReport = {
  rows: AttendanceRow[];
  totals: AttendanceCounts;
};

/** §3.3: one row per (student, group), sorted by group, student, ids. */
export function attendanceReport(input: AttendanceInput): AttendanceReport {
  const { filters, now, range } = input;
  const membershipsOf = new Map<string, ReportMembership[]>();
  for (const m of input.memberships) {
    const list = membershipsOf.get(m.groupId) ?? [];
    list.push(m);
    membershipsOf.set(m.groupId, list);
  }
  const absenceOf = new Map(
    input.absences.map((a) => [`${a.lessonId}|${a.studentId}`, a]),
  );
  const counts = new Map<
    string,
    { studentId: string; groupId: string } & Omit<
      AttendanceCounts,
      "attended" | "attendanceRate" | "absentLate"
    >
  >();
  const row = (studentId: string, groupId: string) => {
    const key = `${groupId}|${studentId}`;
    let r = counts.get(key);
    if (!r) {
      r = {
        studentId,
        groupId,
        expected: 0,
        absent: 0,
        absentWithCredit: 0,
        makeupsAttended: 0,
      };
      counts.set(key, r);
    }
    return r;
  };
  const teacherOk = (lesson: ReportLesson) =>
    !filters.teacherId || effectiveTeacher(lesson) === filters.teacherId;
  const studentOk = (studentId: string) =>
    !filters.studentId || studentId === filters.studentId;
  const groupOk = (groupId: string) =>
    !filters.groupId || groupId === filters.groupId;

  const counted = input.lessons.filter(
    (l) => hasEnded(l, now) && startsIn(l, range) && teacherOk(l),
  );
  const makeup = new Map(
    counted.map((l) => [l.id, isMakeupLesson(l, input.chain)]),
  );

  // Expected lessons and absences.
  for (const lesson of counted) {
    if (!groupOk(lesson.groupId)) continue;
    // One membership per (group, student): the table's unique key.
    for (const m of membershipsOf.get(lesson.groupId) ?? []) {
      if (!studentOk(m.studentId)) continue;
      const absence = absenceOf.get(`${lesson.id}|${m.studentId}`);
      if (!expectedFor([m], lesson, !!absence, makeup.get(lesson.id)!)) {
        continue;
      }
      const r = row(m.studentId, lesson.groupId);
      r.expected++;
      if (absence) {
        r.absent++;
        if (absence.hasCredit) r.absentWithCredit++;
      }
    }
  }

  // Makeups attended, counted in the row whose credit paid for them.
  const byId = new Map(counted.map((l) => [l.id, l]));
  const active = new Set<string>(ACTIVE_REPLACEMENT_STATUSES);
  for (const r of input.replacements) {
    if (!active.has(r.status)) continue;
    const target = byId.get(r.targetLessonId);
    if (!target || target.status === "CANCELLED") continue;
    if (!studentOk(r.studentId) || !groupOk(r.originalGroupId)) continue;
    row(r.studentId, r.originalGroupId).makeupsAttended++;
  }
  for (const lesson of counted) {
    if (lesson.status === "CANCELLED" || !makeup.get(lesson.id)) continue;
    if (!groupOk(lesson.groupId)) continue;
    if (input.groups.get(lesson.groupId)?.type !== "ONE_ON_ONE") continue;
    for (const m of membershipsOf.get(lesson.groupId) ?? []) {
      if (
        studentOk(m.studentId) &&
        isMemberAt([m], m.groupId, lesson.startsAt)
      ) {
        row(m.studentId, lesson.groupId).makeupsAttended++;
      }
    }
  }

  const rows: AttendanceRow[] = [];
  for (const c of counts.values()) {
    const group = input.groups.get(c.groupId);
    const student = input.students.get(c.studentId);
    const attended = c.expected - c.absent;
    rows.push({
      ...c,
      absentLate: c.absent - c.absentWithCredit,
      attended,
      attendanceRate: attendanceRate(attended, c.expected),
      studentName: student?.name ?? "",
      studentArchived: student?.archived ?? false,
      groupName: group?.name ?? "",
      groupType: group?.type ?? "GROUP",
      levelCode: group?.levelCode ?? "",
      groupArchived: group?.archived ?? false,
    });
  }
  rows.sort(compareAttendance);
  return { rows, totals: attendanceTotals(rows) };
}

const compareAttendance = (a: AttendanceRow, b: AttendanceRow) =>
  a.groupName.localeCompare(b.groupName) ||
  a.studentName.localeCompare(b.studentName) ||
  a.groupId.localeCompare(b.groupId) ||
  a.studentId.localeCompare(b.studentId);

/** Column sums; the overall rate is from the sums, not an average (§3.3). */
export function attendanceTotals(
  rows: readonly AttendanceCounts[],
): AttendanceCounts {
  const sum = (key: keyof Omit<AttendanceCounts, "attendanceRate">) =>
    rows.reduce((total, r) => total + r[key], 0);
  const expected = sum("expected");
  const attended = sum("attended");
  return {
    expected,
    absent: sum("absent"),
    absentWithCredit: sum("absentWithCredit"),
    absentLate: sum("absentLate"),
    attended,
    attendanceRate: attendanceRate(attended, expected),
    makeupsAttended: sum("makeupsAttended"),
  };
}

export const ATTENDANCE_SORTS = [
  "group",
  "student",
  "expected",
  "absent",
  "attended",
  "rate",
  "makeups",
] as const;
export type AttendanceSort = (typeof ATTENDANCE_SORTS)[number];
export type SortDirection = "asc" | "desc";

/**
 * The page's column sort (§3.3); ties fall back to the default order. No
 * rate (nothing expected) sorts after every rate, both ways.
 */
export function sortAttendance(
  rows: readonly AttendanceRow[],
  sort: AttendanceSort,
  direction: SortDirection,
): AttendanceRow[] {
  const sign = direction === "asc" ? 1 : -1;
  const value = (r: AttendanceRow): number | string | null => {
    switch (sort) {
      case "group":
        return null;
      case "student":
        return r.studentName;
      case "expected":
        return r.expected;
      case "absent":
        return r.absent;
      case "attended":
        return r.attended;
      case "rate":
        return r.attendanceRate;
      case "makeups":
        return r.makeupsAttended;
    }
  };
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (sort === "group") return sign * compareAttendance(a, b);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
      return compareAttendance(a, b);
    }
    const primary =
      typeof va === "string"
        ? va.localeCompare(vb as string)
        : va - (vb as number);
    return sign * primary || compareAttendance(a, b);
  });
}

// ---------------------------------------------------------------------------
// Teacher hours (§4)
// ---------------------------------------------------------------------------

export type TeacherHoursFilters = { teacherId?: string; groupId?: string };

export type TeacherHoursInput = {
  lessons: readonly ReportLesson[];
  teachers: ReadonlyMap<string, ReportPerson>;
  range: { from: Date; to: Date };
  now: Date;
  filters: TeacherHoursFilters;
};

export type TeacherHoursCounts = {
  lessons: number;
  regularMinutes: number;
  substituteMinutes: number;
  totalMinutes: number;
  coveredByOthersMinutes: number;
};

export type TeacherHoursRow = TeacherHoursCounts & {
  teacherId: string;
  name: string;
  archived: boolean;
  /** `totalMinutes` as decimal hours ("12.50"). */
  hours: string;
};

export type TeacherHoursReport = {
  rows: TeacherHoursRow[];
  totals: TeacherHoursCounts;
};

/** `ended`: ended, non-cancelled lessons in the period and group (§4.1). */
function endedLessons(input: TeacherHoursInput): ReportLesson[] {
  return input.lessons.filter(
    (l) =>
      hasEnded(l, input.now) &&
      l.status !== "CANCELLED" &&
      startsIn(l, input.range) &&
      (!input.filters.groupId || l.groupId === input.filters.groupId),
  );
}

/**
 * §4.1: one row per teacher who taught an ended lesson in the period (as
 * regular teacher or substitute), sorted by name, then id. Minutes are
 * `teachingMinutes`, so a covered lesson counts for the substitute only.
 */
export function teacherHoursReport(
  input: TeacherHoursInput,
): TeacherHoursReport {
  const ended = endedLessons(input);
  const own = ended.filter((l) => l.substituteTeacherId === null);
  const covered = ended.filter((l) => l.substituteTeacherId !== null);
  const taught = new Set(ended.map(effectiveTeacher));
  const rows: TeacherHoursRow[] = [];
  for (const teacherId of taught) {
    if (input.filters.teacherId && teacherId !== input.filters.teacherId) {
      continue;
    }
    const teacher = input.teachers.get(teacherId);
    const totalMinutes = teachingMinutes(ended, teacherId, input.range);
    rows.push({
      teacherId,
      name: teacher?.name ?? "",
      archived: teacher?.archived ?? false,
      lessons: ended.filter((l) => effectiveTeacher(l) === teacherId).length,
      regularMinutes: teachingMinutes(own, teacherId, input.range),
      substituteMinutes: teachingMinutes(covered, teacherId, input.range),
      totalMinutes,
      hours: minutesToHours(totalMinutes),
      coveredByOthersMinutes: covered
        .filter(
          (l) =>
            l.teacherId === teacherId && l.substituteTeacherId !== teacherId,
        )
        .reduce((total, l) => total + lessonMinutes(l), 0),
    });
  }
  rows.sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.teacherId.localeCompare(b.teacherId),
  );
  return { rows, totals: teacherHoursTotals(rows) };
}

export function teacherHoursTotals(
  rows: readonly TeacherHoursCounts[],
): TeacherHoursCounts {
  const sum = (key: keyof TeacherHoursCounts) =>
    rows.reduce((total, r) => total + r[key], 0);
  return {
    lessons: sum("lessons"),
    regularMinutes: sum("regularMinutes"),
    substituteMinutes: sum("substituteMinutes"),
    totalMinutes: sum("totalMinutes"),
    coveredByOthersMinutes: sum("coveredByOthersMinutes"),
  };
}

export type TeacherLessonRow = {
  lessonId: string;
  startsAt: Date;
  /** Local `YYYY-MM-DD` and `HH:mm` in the school's time zone. */
  date: IsoDate;
  start: string;
  end: string;
  minutes: number;
  teacherId: string;
  teacherName: string;
  role: "REGULAR" | "SUBSTITUTE";
  regularTeacherId: string;
  regularTeacherName: string;
  groupId: string;
  groupName: string;
  groupType: "GROUP" | "ONE_ON_ONE";
  levelCode: string;
  roomName: string | null;
};

/**
 * §4.2: one row per `ended` lesson passing the filters (with `teacherId`,
 * the lessons that teacher taught), sorted by start, then id.
 */
export function teacherHoursLessons(
  input: TeacherHoursInput & {
    groups: ReadonlyMap<string, ReportGroup>;
    rooms: ReadonlyMap<string, string>;
    timeZone: string;
  },
): TeacherLessonRow[] {
  const name = (id: string) => input.teachers.get(id)?.name ?? "";
  const local = (instant: Date) => toZonedDateTime(instant, input.timeZone);
  return endedLessons(input)
    .filter(
      (l) =>
        !input.filters.teacherId ||
        effectiveTeacher(l) === input.filters.teacherId,
    )
    .sort(byStart)
    .map((l) => {
      const group = input.groups.get(l.groupId);
      const start = local(l.startsAt);
      const teacherId = effectiveTeacher(l);
      return {
        lessonId: l.id,
        startsAt: l.startsAt,
        date: start.date,
        start: formatMinutes(start.minute),
        end: formatMinutes(local(l.endsAt).minute),
        minutes: lessonMinutes(l),
        teacherId,
        teacherName: name(teacherId),
        role: l.substituteTeacherId === null ? "REGULAR" : "SUBSTITUTE",
        regularTeacherId: l.teacherId,
        regularTeacherName: name(l.teacherId),
        groupId: l.groupId,
        groupName: group?.name ?? "",
        groupType: group?.type ?? "GROUP",
        levelCode: group?.levelCode ?? "",
        roomName: (l.roomId && input.rooms.get(l.roomId)) ?? null,
      };
    });
}
