import { unavailabilityRules } from "./availability";
import {
  CONFLICT_SEVERITY,
  CONFLICT_TYPES,
  type Conflict,
  type ConflictCounterpart,
  type ConflictParams,
  type ConflictRefs,
  type ConflictType,
} from "./conflict-types";
import {
  compareStrings,
  isHoliday,
  occurrenceOf,
  slotOccurrenceDates,
} from "./generate-lessons";
import { seatsTaken } from "./replacements";
import {
  formatMinutes,
  type IsoDate,
  isoWeekday,
  toZonedDateTime,
} from "./time";
import type {
  GroupInfo,
  HolidayInfo,
  LessonCandidate,
  LessonInfo,
  PersonInfo,
  RoomInfo,
  SchedulingContext,
  SlotCandidate,
  SlotInfo,
  TermInfo,
} from "./types";

// ---------------------------------------------------------------------------
// Calendar: every booked lesson-time in the context, indexed by local date
// ---------------------------------------------------------------------------

/** One occupied time: a lesson, or a slot occurrence with no lesson row yet. */
type Booking = {
  counterpart: ConflictCounterpart;
  slotId: string | null;
  lessonId: string | null;
  date: IsoDate;
  start: number;
  end: number;
  startMinute: number;
  endMinute: number;
  /** The teacher actually teaching: `substituteTeacherId ?? teacherId`. */
  teacherId: string;
  roomId: string | null;
  groupId: string;
  /** Who attends: see `attendeesOf`. */
  studentIds: readonly string[];
};

/**
 * The context, indexed once so many candidates can be checked cheaply
 * (the editor checks one; the generator and `checkTimetable` check all).
 */
export type Calendar = {
  context: SchedulingContext;
  bookingsByDate: ReadonlyMap<IsoDate, readonly Booking[]>;
  terms: ReadonlyMap<string, TermInfo>;
  slots: ReadonlyMap<string, SlotInfo>;
  lessons: ReadonlyMap<string, LessonInfo>;
  groups: ReadonlyMap<string, GroupInfo>;
  rooms: ReadonlyMap<string, RoomInfo>;
  teachers: ReadonlyMap<string, PersonInfo>;
  students: ReadonlyMap<string, PersonInfo>;
  /** Students absent from each lesson, by lesson id. */
  absentByLesson: ReadonlyMap<string, ReadonlySet<string>>;
  /** Students booked into each lesson as active replacements, by lesson id. */
  replacementsByLesson: ReadonlyMap<string, readonly string[]>;
  /** Levels per teacher; null when the context has no `teacherLevels`. */
  teacherLevels: ReadonlyMap<string, ReadonlySet<string>> | null;
};

/**
 * Sentinel teacher id: `checkSlot` / `checkLesson` with it skip every
 * teacher rule and report only the conflicts of the time itself (room,
 * group, students, term, school hours). Used by the generator's readiness
 * check and the group form's live check (generator.md §4.3).
 */
export const UNASSIGNED_TEACHER = "__unassigned__";

/** Conflict types about the teacher; never reported for `UNASSIGNED_TEACHER`. */
export const TEACHER_CONFLICT_TYPES: readonly ConflictType[] = [
  "TEACHER_DOUBLE_BOOKED",
  "TEACHER_UNAVAILABLE_WEEKLY",
  "TEACHER_UNAVAILABLE_ON_DATE",
  "TEACHER_LEVEL_NOT_TAUGHT",
];

const byId = <T extends { id: string }>(items: readonly T[]) =>
  new Map(items.map((item) => [item.id, item]));

function byLesson(rows: SchedulingContext["absences"]) {
  const out = new Map<string, string[]>();
  for (const { lessonId, studentId } of rows ?? []) {
    const list = out.get(lessonId);
    if (list) list.push(studentId);
    else out.set(lessonId, [studentId]);
  }
  return out;
}

/**
 * Who attends a lesson and how many seats it takes (replacements.md §5):
 * the group's enrolled students minus those who reported an absence on it,
 * plus its active replacement students. A slot occurrence without a lesson
 * row (`lessonId` null) has neither, so it is the enrolled students.
 */
export function attendeesOf(
  calendar: Pick<Calendar, "absentByLesson" | "replacementsByLesson">,
  lessonId: string | null,
  group: GroupInfo,
): { studentIds: string[]; seats: number } {
  const absent =
    (lessonId && calendar.absentByLesson.get(lessonId)) || new Set<string>();
  const replacements =
    (lessonId && calendar.replacementsByLesson.get(lessonId)) || [];
  const present = group.studentIds.filter((id) => !absent.has(id));
  return {
    studentIds: [...new Set([...present, ...replacements])],
    seats: seatsTaken({
      memberIds: group.studentIds,
      absentIds: [...absent],
      replacementIds: replacements,
    }),
  };
}

/** Holidays that apply to a term: its own plus the school-wide ones. */
export function holidaysOfTerm(
  holidays: readonly HolidayInfo[],
  termId: string,
): HolidayInfo[] {
  return holidays.filter((h) => h.termId === null || h.termId === termId);
}

/**
 * Indexes the context. A generated lesson replaces its slot's occurrence on
 * that date (so a moved or substituted lesson is checked where and with whom
 * it actually takes place); cancelled lessons occupy nothing; slot
 * occurrences without a lesson row (draft terms, dates not generated yet)
 * count as booked.
 */
export function buildCalendar(context: SchedulingContext): Calendar {
  const { timeZone } = context.school;
  const terms = byId(context.terms);
  const groups = byId(context.groups);
  const attendance = {
    absentByLesson: new Map(
      [...byLesson(context.absences)].map(([id, ids]) => [id, new Set(ids)]),
    ),
    replacementsByLesson: byLesson(context.replacements),
  };
  const enrolled = (groupId: string) => groups.get(groupId)?.studentIds ?? [];
  const bookingsByDate = new Map<IsoDate, Booking[]>();
  const add = (booking: Booking) => {
    const list = bookingsByDate.get(booking.date);
    if (list) list.push(booking);
    else bookingsByDate.set(booking.date, [booking]);
  };

  const materialized = new Set<string>();
  for (const lesson of context.lessons) {
    if (lesson.timetableSlotId && lesson.occurrenceDate) {
      materialized.add(`${lesson.timetableSlotId}|${lesson.occurrenceDate}`);
    }
    if (lesson.status === "CANCELLED") continue;
    const local = toZonedDateTime(lesson.startsAt, timeZone);
    const minutes = (lesson.endsAt.getTime() - lesson.startsAt.getTime()) / 6e4;
    add({
      counterpart: lesson.timetableSlotId
        ? { kind: "slot", id: lesson.timetableSlotId }
        : { kind: "lesson", id: lesson.id },
      slotId: lesson.timetableSlotId,
      lessonId: lesson.id,
      date: local.date,
      start: lesson.startsAt.getTime(),
      end: lesson.endsAt.getTime(),
      startMinute: local.minute,
      endMinute: local.minute + minutes,
      teacherId: lesson.substituteTeacherId ?? lesson.teacherId,
      roomId: lesson.roomId,
      groupId: lesson.groupId,
      studentIds: groups.has(lesson.groupId)
        ? attendeesOf(attendance, lesson.id, groups.get(lesson.groupId)!)
            .studentIds
        : [],
    });
  }

  for (const slot of context.slots) {
    const term = terms.get(slot.termId);
    if (!term) continue;
    const holidays = holidaysOfTerm(context.holidays, slot.termId);
    for (const date of slotOccurrenceDates(slot, term, holidays)) {
      if (materialized.has(`${slot.id}|${date}`)) continue;
      const occurrence = occurrenceOf(slot, date, timeZone);
      add({
        counterpart: { kind: "slot", id: slot.id },
        slotId: slot.id,
        lessonId: null,
        date,
        start: occurrence.startsAt.getTime(),
        end: occurrence.endsAt.getTime(),
        startMinute: slot.startMinute,
        endMinute: slot.endMinute,
        teacherId: slot.teacherId,
        roomId: slot.roomId,
        groupId: slot.groupId,
        studentIds: enrolled(slot.groupId),
      });
    }
  }

  let teacherLevels: Map<string, Set<string>> | null = null;
  if (context.teacherLevels) {
    teacherLevels = new Map();
    for (const { teacherId, levelId } of context.teacherLevels) {
      const set = teacherLevels.get(teacherId);
      if (set) set.add(levelId);
      else teacherLevels.set(teacherId, new Set([levelId]));
    }
  }

  return {
    context,
    teacherLevels,
    bookingsByDate,
    terms,
    slots: byId(context.slots),
    lessons: byId(context.lessons),
    groups,
    rooms: byId(context.rooms),
    teachers: byId(context.teachers),
    students: byId(context.students),
    ...attendance,
  };
}

// ---------------------------------------------------------------------------
// Conflict collection
// ---------------------------------------------------------------------------

/** A candidate occurrence: one date of a slot, or the single lesson. */
type Occurrence = {
  date: IsoDate;
  start: number;
  end: number;
  startMinute: number;
  endMinute: number;
};

/** The candidate reduced to what the checks need. */
type Subject = {
  group: GroupInfo;
  teacher: PersonInfo;
  room: RoomInfo | null;
  /**
   * Rooms the candidate already has as stored (its slot's, or its lesson's
   * and that lesson's slot's). Staying in an archived room is allowed;
   * moving into one is not.
   */
  keptRoomIds: readonly (string | null)[];
  occurrences: Occurrence[];
  /** Who attends the candidate (clashes) and the seats it takes (room size). */
  attendees: { studentIds: readonly string[]; seats: number };
  /** Bookings of the candidate itself (when editing), never compared. */
  isSelf: (booking: Booking) => boolean;
};

/** Accumulates conflicts, merging repeats of the same key across dates. */
class ConflictSet {
  private readonly byKey = new Map<string, Conflict>();

  add(
    type: ConflictType,
    keySuffix: string,
    params: ConflictParams,
    refs: ConflictRefs,
    date?: IsoDate,
  ) {
    const key = keySuffix ? `${type}:${keySuffix}` : type;
    let conflict = this.byKey.get(key);
    if (!conflict) {
      conflict = {
        type,
        severity: CONFLICT_SEVERITY[type],
        key,
        dates: [],
        params,
        refs,
      };
      this.byKey.set(key, conflict);
    }
    if (date && !conflict.dates.includes(date)) conflict.dates.push(date);
    return conflict;
  }

  /** Conflicts in display order, with date counts filled in. */
  list(): Conflict[] {
    const order = (type: ConflictType) => CONFLICT_TYPES.indexOf(type);
    return [...this.byKey.values()]
      .map((conflict) => {
        const dates = [...conflict.dates].sort(compareStrings);
        const params = dates.length
          ? { ...conflict.params, dateCount: dates.length, firstDate: dates[0] }
          : conflict.params;
        return { ...conflict, dates, params };
      })
      .sort(
        (a, b) => order(a.type) - order(b.type) || compareStrings(a.key, b.key),
      );
  }
}

const timeRange = (start: number, end: number) =>
  `${formatMinutes(start)}–${formatMinutes(end)}`;

function lookup<T>(map: ReadonlyMap<string, T>, id: string, what: string): T {
  const value = map.get(id);
  if (value === undefined) {
    throw new Error(`Scheduling context is missing ${what} ${id}`);
  }
  return value;
}

function teacherOf(calendar: Calendar, id: string): PersonInfo {
  return id === UNASSIGNED_TEACHER
    ? { id, name: "" }
    : lookup(calendar.teachers, id, "teacher");
}

/** Checks shared by slots and lessons: resources, people, rooms, availability. */
function collect(calendar: Calendar, subject: Subject, out: ConflictSet) {
  const { group, teacher, room, occurrences } = subject;
  const { context } = calendar;

  if (group.archived) {
    out.add("GROUP_ARCHIVED", "", { group: group.name }, { groupId: group.id });
  }
  if (room?.archived && !subject.keptRoomIds.includes(room.id)) {
    out.add("ROOM_ARCHIVED", "", { room: room.name }, { roomId: room.id });
  }

  const studentCount = group.studentIds.length;
  if (group.type === "ONE_ON_ONE" && studentCount !== 1) {
    out.add(
      "ONE_ON_ONE_STUDENT_COUNT",
      group.id,
      { group: group.name, studentCount },
      { groupId: group.id },
    );
  }
  if (group.type === "GROUP" && studentCount > group.capacity) {
    out.add(
      "GROUP_OVER_CAPACITY",
      group.id,
      { group: group.name, capacity: group.capacity, studentCount },
      { groupId: group.id },
    );
  }
  const seats = subject.attendees.seats;
  if (room?.capacity != null && seats > room.capacity) {
    out.add(
      "ROOM_CAPACITY_EXCEEDED",
      room.id,
      { room: room.name, capacity: room.capacity, studentCount: seats },
      { roomId: room.id, groupId: group.id },
    );
  }

  const unassigned = teacher.id === UNASSIGNED_TEACHER;
  // A teacher without any level rows gets no warning: the school may not
  // use levels yet (generator.md §4.3).
  const taught = calendar.teacherLevels?.get(teacher.id);
  if (!unassigned && taught && group.levelId && !taught.has(group.levelId)) {
    const level = context.levels?.find((l) => l.id === group.levelId);
    out.add(
      "TEACHER_LEVEL_NOT_TAUGHT",
      `${teacher.id}:${group.levelId}`,
      { teacher: teacher.name, level: level?.name ?? group.levelId },
      { teacherId: teacher.id, groupId: group.id },
    );
  }

  const { dayStartMinute, dayEndMinute } = context.school;
  const attending = new Set(subject.attendees.studentIds);

  for (const occ of occurrences) {
    if (occ.startMinute < dayStartMinute || occ.endMinute > dayEndMinute) {
      out.add(
        "OUTSIDE_SCHOOL_HOURS",
        "",
        {
          time: timeRange(occ.startMinute, occ.endMinute),
          schoolHours: timeRange(dayStartMinute, dayEndMinute),
        },
        {},
        occ.date,
      );
    }

    for (const rule of unassigned
      ? []
      : unavailabilityRules(
          context.availability,
          teacher.id,
          occ.date,
          occ.startMinute,
          occ.endMinute,
        )) {
      const weekly = rule.kind === "WEEKLY_UNAVAILABLE";
      out.add(
        weekly ? "TEACHER_UNAVAILABLE_WEEKLY" : "TEACHER_UNAVAILABLE_ON_DATE",
        rule.id,
        {
          teacher: teacher.name,
          allDay: rule.startMinute === null ? "yes" : "no",
          time:
            rule.startMinute === null || rule.endMinute === null
              ? ""
              : timeRange(rule.startMinute, rule.endMinute),
        },
        { teacherId: teacher.id, availabilityId: rule.id },
        occ.date,
      );
    }

    for (const other of calendar.bookingsByDate.get(occ.date) ?? []) {
      if (subject.isSelf(other)) continue;
      if (!(occ.start < other.end && other.start < occ.end)) continue;

      const otherGroup = lookup(calendar.groups, other.groupId, "group");
      const counterpartKey = `${other.counterpart.kind}:${other.counterpart.id}`;
      const shared = {
        otherGroup: otherGroup.name,
        otherTime: timeRange(other.startMinute, other.endMinute),
      };
      const counterpart = other.counterpart;

      if (!unassigned && other.teacherId === teacher.id) {
        out.add(
          "TEACHER_DOUBLE_BOOKED",
          counterpartKey,
          { teacher: teacher.name, ...shared },
          { teacherId: teacher.id, groupId: other.groupId, counterpart },
          occ.date,
        );
      }
      if (room && other.roomId === room.id) {
        out.add(
          room.kind === "ONLINE" ? "ONLINE_ROOM_SHARED" : "ROOM_DOUBLE_BOOKED",
          counterpartKey,
          { room: room.name, ...shared },
          { roomId: room.id, groupId: other.groupId, counterpart },
          occ.date,
        );
      }
      if (other.groupId === group.id) {
        out.add(
          "GROUP_DOUBLE_BOOKED",
          counterpartKey,
          { group: group.name, ...shared },
          { groupId: group.id, counterpart },
          occ.date,
        );
      } else {
        const both = other.studentIds.filter((s) => attending.has(s));
        if (both.length > 0) {
          const conflict = out.add(
            "STUDENT_DOUBLE_BOOKED",
            counterpartKey,
            shared,
            { groupId: other.groupId, studentIds: [], counterpart },
            occ.date,
          );
          const ids = new Set([...(conflict.refs.studentIds ?? []), ...both]);
          conflict.refs.studentIds = [...ids].sort(compareStrings);
          conflict.params = {
            ...shared,
            studentCount: ids.size,
            students: conflict.refs.studentIds
              .map((id) => lookup(calendar.students, id, "student").name)
              .sort(compareStrings)
              .join(", "),
          };
        }
      }
    }
  }
}

function isValidTime(weekday: number, startMinute: number, endMinute: number) {
  return (
    Number.isInteger(weekday) &&
    weekday >= 1 &&
    weekday <= 7 &&
    Number.isInteger(startMinute) &&
    Number.isInteger(endMinute) &&
    startMinute >= 0 &&
    startMinute < endMinute &&
    endMinute <= 1440
  );
}

/**
 * Conflicts of a proposed or edited weekly slot. Every date the slot would
 * produce a lesson on (its weekday within the term and its validity range,
 * minus holidays) is compared with every lesson and slot in the calendar.
 */
export function checkSlot(
  calendar: Calendar,
  candidate: SlotCandidate,
): Conflict[] {
  const out = new ConflictSet();
  const term = lookup(calendar.terms, candidate.termId, "term");
  const termParams = {
    term: term.name,
    termStart: term.startDate,
    termEnd: term.endDate,
  };

  if (
    !isValidTime(candidate.weekday, candidate.startMinute, candidate.endMinute)
  ) {
    out.add("INVALID_TIME", "", {}, {});
    return out.list();
  }
  const from = candidate.validFrom ?? term.startDate;
  const until = candidate.validUntil ?? term.endDate;
  if (from > until || from > term.endDate || until < term.startDate) {
    out.add("OUTSIDE_TERM", "", termParams, { termId: term.id });
    return out.list();
  }

  const { teachingWeekdays } = calendar.context.school;
  if (!teachingWeekdays.includes(candidate.weekday)) {
    out.add("OUTSIDE_SCHOOL_DAYS", "", { weekday: candidate.weekday }, {});
  }

  const holidays = holidaysOfTerm(calendar.context.holidays, term.id);
  const dates = slotOccurrenceDates(candidate, term, holidays);
  if (dates.length === 0) out.add("NO_OCCURRENCES", "", termParams, {});

  const { timeZone } = calendar.context.school;
  const template = { ...candidate, id: candidate.id ?? "" };
  const selfId = candidate.id;
  const group = lookup(calendar.groups, candidate.groupId, "group");
  collect(
    calendar,
    {
      group,
      // A weekly slot has no per-date absences or replacements.
      attendees: attendeesOf(calendar, null, group),
      teacher: teacherOf(calendar, candidate.teacherId),
      room: candidate.roomId
        ? lookup(calendar.rooms, candidate.roomId, "room")
        : null,
      keptRoomIds:
        selfId !== undefined && calendar.slots.has(selfId)
          ? [calendar.slots.get(selfId)!.roomId]
          : [],
      occurrences: dates.map((date) => {
        const o = occurrenceOf(template, date, timeZone);
        return {
          date,
          start: o.startsAt.getTime(),
          end: o.endsAt.getTime(),
          startMinute: candidate.startMinute,
          endMinute: candidate.endMinute,
        };
      }),
      isSelf: (booking) => selfId !== undefined && booking.slotId === selfId,
    },
    out,
  );
  return out.list();
}

/**
 * Conflicts of a single dated lesson: a lesson moved to another time or
 * room, a substitute teacher (checked as the teacher who actually teaches),
 * or an ad-hoc lesson.
 */
export function checkLesson(
  calendar: Calendar,
  candidate: LessonCandidate,
): Conflict[] {
  const out = new ConflictSet();
  const term = lookup(calendar.terms, candidate.termId, "term");
  const { timeZone, teachingWeekdays } = calendar.context.school;
  const local = toZonedDateTime(candidate.startsAt, timeZone);
  const minutes =
    (candidate.endsAt.getTime() - candidate.startsAt.getTime()) / 6e4;

  if (!(minutes > 0) || local.minute + minutes > 1440) {
    out.add("INVALID_TIME", "", {}, {});
    return out.list();
  }
  if (local.date < term.startDate || local.date > term.endDate) {
    out.add(
      "OUTSIDE_TERM",
      "",
      { term: term.name, termStart: term.startDate, termEnd: term.endDate },
      { termId: term.id },
    );
    return out.list();
  }

  const weekday = isoWeekday(local.date);
  if (!teachingWeekdays.includes(weekday)) {
    out.add("OUTSIDE_SCHOOL_DAYS", "", { weekday }, {}, local.date);
  }
  for (const holiday of holidaysOfTerm(calendar.context.holidays, term.id)) {
    if (isHoliday(local.date, [holiday])) {
      out.add(
        "LESSON_ON_HOLIDAY",
        holiday.id,
        { holiday: holiday.name },
        { holidayId: holiday.id },
        local.date,
      );
    }
  }

  const selfId = candidate.id;
  const ownSlotDate =
    candidate.timetableSlotId && candidate.occurrenceDate
      ? `${candidate.timetableSlotId}|${candidate.occurrenceDate}`
      : null;
  const group = lookup(calendar.groups, candidate.groupId, "group");
  collect(
    calendar,
    {
      group,
      // An existing lesson keeps its absences and replacement students.
      attendees: attendeesOf(calendar, selfId ?? null, group),
      teacher: teacherOf(
        calendar,
        candidate.substituteTeacherId ?? candidate.teacherId,
      ),
      room: candidate.roomId
        ? lookup(calendar.rooms, candidate.roomId, "room")
        : null,
      keptRoomIds: [
        selfId === undefined ? undefined : calendar.lessons.get(selfId),
        candidate.timetableSlotId === null
          ? undefined
          : calendar.slots.get(candidate.timetableSlotId),
      ].flatMap((stored) => (stored ? [stored.roomId] : [])),
      occurrences: [
        {
          date: local.date,
          start: candidate.startsAt.getTime(),
          end: candidate.endsAt.getTime(),
          startMinute: local.minute,
          endMinute: local.minute + minutes,
        },
      ],
      // The lesson itself, and the slot occurrence it stands for.
      isSelf: (booking) =>
        (selfId !== undefined && booking.lessonId === selfId) ||
        (ownSlotDate !== null &&
          booking.lessonId === null &&
          `${booking.slotId}|${booking.date}` === ownSlotDate),
    },
    out,
  );
  return out.list();
}

/**
 * Conflicts of every slot of a term, keyed by slot id (slots without
 * conflicts are omitted). Used before publishing and by the generator.
 * A clash between two slots is reported on both.
 */
export function checkTimetable(
  calendar: Calendar,
  termId: string,
): Map<string, Conflict[]> {
  const result = new Map<string, Conflict[]>();
  const slots: SlotInfo[] = calendar.context.slots
    .filter((slot) => slot.termId === termId)
    .sort((a, b) => compareStrings(a.id, b.id));
  for (const slot of slots) {
    const conflicts = checkSlot(calendar, slot);
    if (conflicts.length > 0) result.set(slot.id, conflicts);
  }
  return result;
}
