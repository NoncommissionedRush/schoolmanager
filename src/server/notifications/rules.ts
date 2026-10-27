// Notification rules (docs/architecture/phase5-rules.md §2): who is told
// what, how unread notifications about the same subject merge, how a bulk
// timetable change is summarised per person, and how long rows are kept.
// Pure: plain data in, plain data out, no Prisma, no Next.js, no clock
// (the service passes `now`).

import { type IsoDate, toZonedDateTime } from "@/server/scheduling";

/** Every notification is deleted this many days after it was created (§2.5). */
export const NOTIFICATION_RETENTION_DAYS = 90;
/** Inbox page size (§2.7); the header popover shows fewer. */
export const INBOX_PAGE_SIZE = 20;
export const POPOVER_SIZE = 8;
/** The unread count is counted up to this many (the badge shows "9+"). */
export const UNREAD_COUNT_CAP = 100;

export const NOTIFICATION_TYPES = [
  "LESSON_CANCELLED",
  "LESSON_MOVED",
  "SUBSTITUTE_ASSIGNED",
  "SUBSTITUTE_REMOVED",
  "ABSENCE_REPORTED",
  "REPLACEMENT_BOOKED",
  "REPLACEMENT_ENDED",
  "REPLACEMENT_MOVED",
  "REPLACEMENT_REVIEW_PENDING",
  "AVAILABILITY_REQUEST_PENDING",
  "AVAILABILITY_REQUEST_DECIDED",
  "TIMETABLE_PUBLISHED",
  "TIMETABLE_CHANGED",
  "CALENDAR_FEED_REVOKED",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Selects the message variant (§2.2). */
export type Audience =
  "teacher" | "regular" | "substitute" | "student" | "admin";

/**
 * Where a notification leads, resolved per role at read time (§2.4).
 * `absences` is the student's Absences tab (design §4.4: admin-made
 * absences and ended replacements link there).
 */
export type NotificationLink =
  | { kind: "lesson"; lessonId: string }
  | { kind: "timetable"; date: IsoDate }
  | { kind: "replacementReview" }
  | { kind: "absences" }
  | { kind: "calendarFeed" }
  | { kind: "availability"; teacherId: string };

/** ICU params; instants are ISO strings, display names are snapshots. */
export type NotificationParams = Record<string, string | number | null>;

/** One notification for one recipient, before it is stored. */
export type NotificationDraft = {
  recipientId: string;
  audience: Audience;
  type: NotificationType;
  params: NotificationParams;
  link: NotificationLink | null;
  /** What the event is about, for `sourceKey` = `<source>:<type>:<subject>`. */
  subject: string;
  coalesceKey: string | null;
};

/** A user as a recipient: `User.id` plus the display name to snapshot. */
export type PersonRef = { userId: string; name: string };

/** What the rules need to know about one lesson. */
export type LessonFacts = {
  id: string;
  groupName: string;
  lessonType: "GROUP" | "ONE_ON_ONE";
  startsAt: Date;
  endsAt: Date;
  room: string | null;
  /** The regular teacher (`Lesson.teacherId`). */
  teacher: PersonRef;
  substitute: PersonRef | null;
  /**
   * `User.id`s of the students attending (`attendeesOf`): current members
   * without an absence report on the lesson, plus active replacements.
   */
  attendees: readonly string[];
};

export type TermFacts = {
  id: string;
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
};

export type ChangeCounts = {
  added: number;
  cancelled: number;
  moved: number;
  teacherChanged: number;
};

export type NotificationEvent =
  | { type: "LESSON_CANCELLED"; lesson: LessonFacts; reason: string }
  | {
      type: "LESSON_MOVED";
      /** The lesson after the move (the new one for a reschedule). */
      lesson: LessonFacts;
      old: { startsAt: Date; endsAt: Date; room: string | null };
      /** A student's own reschedule: only the teachers are told. */
      teachersOnly?: boolean;
    }
  | {
      type: "SUBSTITUTE_ASSIGNED";
      /** The lesson after the change (`substitute` = the new one). */
      lesson: LessonFacts;
      /** The substitute before, for a change. */
      previous: PersonRef | null;
    }
  | {
      type: "SUBSTITUTE_REMOVED";
      lesson: LessonFacts;
      removed: PersonRef;
      /** The substitute after: null for a remove, the new one for a change. */
      next: PersonRef | null;
      /**
       * Only the removed substitute is told: a change (the others get
       * `SUBSTITUTE_ASSIGNED`) or a reschedule (they get `LESSON_MOVED`).
       */
      substituteOnly?: boolean;
    }
  | {
      type: "ABSENCE_REPORTED";
      lesson: LessonFacts;
      student: PersonRef;
      withCredit: boolean;
      byAdmin: boolean;
    }
  | {
      type: "REPLACEMENT_BOOKED";
      lesson: LessonFacts;
      student: PersonRef;
      fromGroup: string;
      byAdmin: boolean;
    }
  | {
      type: "REPLACEMENT_ENDED";
      lesson: LessonFacts;
      student: PersonRef;
      outcome: "cancelled" | "rejected" | "moved";
      creditBack: boolean;
      note: string | null;
      /** The student cancelled it themselves. */
      byStudent: boolean;
      /** Who is told: both (default), or only the student / the teacher. */
      only?: "student" | "teacher";
    }
  | {
      type: "REPLACEMENT_MOVED";
      /** The new target lesson. */
      lesson: LessonFacts;
      student: PersonRef;
      fromGroup: string;
      oldStartsAt: Date;
      note: string | null;
    }
  | { type: "REPLACEMENT_REVIEW_PENDING"; adminIds: readonly string[] }
  | {
      /** A teacher asked to change their availability. */
      type: "AVAILABILITY_REQUEST_PENDING";
      adminIds: readonly string[];
      /** `TeacherProfile.id` and display name. */
      teacher: { id: string; name: string };
    }
  | {
      /** An admin approved or rejected the teacher's request. */
      type: "AVAILABILITY_REQUEST_DECIDED";
      userId: string;
      teacherId: string;
      outcome: "approved" | "rejected";
      note: string | null;
    }
  | {
      type: "TIMETABLE_PUBLISHED";
      term: TermFacts;
      recipients: readonly {
        userId: string;
        audience: "teacher" | "student";
        firstStartsAt: Date | null;
      }[];
    }
  | {
      type: "TIMETABLE_CHANGED";
      term: TermFacts;
      recipients: readonly ChangeSummary[];
    }
  | {
      /** An admin turned a user's calendar link off (§5.1). */
      type: "CALENDAR_FEED_REVOKED";
      userId: string;
      audience: "teacher" | "student";
    };

export type RulesContext = {
  /** The user whose action this is; never notified (§2.1). */
  actorId: string | null;
  now: Date;
  timeZone: string;
};

const lessonLink = (lessonId: string): NotificationLink => ({
  kind: "lesson",
  lessonId,
});

const lessonParams = (lesson: LessonFacts): NotificationParams => ({
  group: lesson.groupName,
  lessonType: lesson.lessonType,
  startsAt: lesson.startsAt.toISOString(),
  endsAt: lesson.endsAt.toISOString(),
});

/**
 * The teachers of a lesson: the effective teacher (`teacher` audience), and
 * the regular one when someone covers (`regular`).
 */
function teachersOf(
  lesson: LessonFacts,
): { person: PersonRef; audience: Audience }[] {
  if (!lesson.substitute)
    return [{ person: lesson.teacher, audience: "teacher" }];
  return [
    { person: lesson.substitute, audience: "teacher" },
    { person: lesson.teacher, audience: "regular" },
  ];
}

/** The effective teacher: `substitute ?? teacher`. */
const effectiveTeacher = (lesson: LessonFacts): PersonRef =>
  lesson.substitute ?? lesson.teacher;

const hasEnded = (lesson: LessonFacts, now: Date) =>
  lesson.endsAt.getTime() <= now.getTime();
const hasStarted = (lesson: LessonFacts, now: Date) =>
  lesson.startsAt.getTime() <= now.getTime();

/**
 * Turns one event into one draft per recipient (§2.2), minus the actor.
 * Lesson events about a lesson that has ended notify nobody (§2.1 rule 5).
 * Student drafts never carry another student's name (§2.4).
 */
export function recipientsFor(
  event: NotificationEvent,
  context: RulesContext,
): NotificationDraft[] {
  const drafts = draftsFor(event, context);
  return drafts.filter((d) => d.recipientId !== context.actorId);
}

function draftsFor(
  event: NotificationEvent,
  { now, timeZone }: RulesContext,
): NotificationDraft[] {
  const out: NotificationDraft[] = [];
  const add = (
    recipientId: string,
    audience: Audience,
    params: NotificationParams,
    link: NotificationLink | null,
    subject: string,
    coalesceKey: string | null = null,
  ) =>
    out.push({
      recipientId,
      audience,
      type: event.type,
      params,
      link,
      subject,
      coalesceKey,
    });

  switch (event.type) {
    case "LESSON_CANCELLED": {
      const { lesson } = event;
      if (hasEnded(lesson, now)) return [];
      const params = { ...lessonParams(lesson), reason: event.reason };
      const subject = `lesson:${lesson.id}`;
      for (const { person, audience } of teachersOf(lesson)) {
        add(person.userId, audience, params, lessonLink(lesson.id), subject);
      }
      for (const id of lesson.attendees) {
        add(id, "student", params, lessonLink(lesson.id), subject);
      }
      return out;
    }
    case "LESSON_MOVED": {
      const { lesson, old } = event;
      if (hasEnded(lesson, now)) return [];
      const params = {
        ...lessonParams(lesson),
        oldStartsAt: old.startsAt.toISOString(),
        oldEndsAt: old.endsAt.toISOString(),
        oldRoom: old.room,
        room: lesson.room,
      };
      const subject = `lesson:${lesson.id}`;
      const key = `lesson:${lesson.id}:moved`;
      for (const { person, audience } of teachersOf(lesson)) {
        add(
          person.userId,
          audience,
          params,
          lessonLink(lesson.id),
          subject,
          key,
        );
      }
      if (!event.teachersOnly) {
        for (const id of lesson.attendees) {
          add(id, "student", params, lessonLink(lesson.id), subject, key);
        }
      }
      return out;
    }
    case "SUBSTITUTE_ASSIGNED": {
      const { lesson } = event;
      if (hasEnded(lesson, now) || !lesson.substitute) return [];
      const params = {
        ...lessonParams(lesson),
        room: lesson.room,
        substitute: lesson.substitute.name,
        teacher: lesson.teacher.name,
        fromId: event.previous?.userId ?? null,
        toId: lesson.substitute.userId,
      };
      const subject = `lesson:${lesson.id}`;
      const key = `lesson:${lesson.id}:substitute`;
      const link = lessonLink(lesson.id);
      add(lesson.substitute.userId, "substitute", params, link, subject, key);
      add(lesson.teacher.userId, "regular", params, link, subject, key);
      if (!hasStarted(lesson, now)) {
        for (const id of lesson.attendees) {
          add(id, "student", params, link, subject, key);
        }
      }
      return out;
    }
    case "SUBSTITUTE_REMOVED": {
      const { lesson, removed, next } = event;
      if (hasEnded(lesson, now)) return [];
      const params = {
        ...lessonParams(lesson),
        substitute: removed.name,
        teacher: lesson.teacher.name,
        fromId: removed.userId,
        toId: next?.userId ?? null,
      };
      const subject = `lesson:${lesson.id}`;
      const key = `lesson:${lesson.id}:substitute`;
      // The removed substitute can no longer open the lesson: their week.
      add(
        removed.userId,
        "substitute",
        params,
        {
          kind: "timetable",
          date: toZonedDateTime(lesson.startsAt, timeZone).date,
        },
        subject,
        key,
      );
      if (!next && !event.substituteOnly) {
        const link = lessonLink(lesson.id);
        add(lesson.teacher.userId, "regular", params, link, subject, key);
        if (!hasStarted(lesson, now)) {
          for (const id of lesson.attendees) {
            add(id, "student", params, link, subject, key);
          }
        }
      }
      return out;
    }
    case "ABSENCE_REPORTED": {
      const { lesson, student } = event;
      if (hasEnded(lesson, now)) return [];
      const base = {
        ...lessonParams(lesson),
        withCredit: event.withCredit ? "yes" : "no",
      };
      const subject = `absence:${lesson.id}:${student.userId}`;
      add(
        effectiveTeacher(lesson).userId,
        "teacher",
        { ...base, student: student.name },
        lessonLink(lesson.id),
        subject,
      );
      if (event.byAdmin) {
        add(student.userId, "student", base, { kind: "absences" }, subject);
      }
      return out;
    }
    case "REPLACEMENT_BOOKED": {
      const { lesson, student } = event;
      if (hasEnded(lesson, now)) return [];
      const base = { ...lessonParams(lesson), fromGroup: event.fromGroup };
      const subject = `replacement:${lesson.id}:${student.userId}`;
      add(
        effectiveTeacher(lesson).userId,
        "teacher",
        { ...base, student: student.name },
        lessonLink(lesson.id),
        subject,
      );
      if (event.byAdmin) {
        add(student.userId, "student", base, lessonLink(lesson.id), subject);
      }
      return out;
    }
    case "REPLACEMENT_ENDED": {
      const { lesson, student } = event;
      if (hasEnded(lesson, now)) return [];
      const base = {
        ...lessonParams(lesson),
        outcome: event.outcome,
        creditBack: event.creditBack ? "yes" : "no",
      };
      const subject = `replacement:${lesson.id}:${student.userId}`;
      if (event.only !== "student") {
        add(
          effectiveTeacher(lesson).userId,
          "teacher",
          { ...base, student: student.name },
          lessonLink(lesson.id),
          subject,
        );
      }
      if (
        event.only !== "teacher" &&
        !event.byStudent &&
        event.outcome !== "moved"
      ) {
        add(
          student.userId,
          "student",
          { ...base, note: event.note },
          { kind: "absences" },
          subject,
        );
      }
      return out;
    }
    case "REPLACEMENT_MOVED": {
      const { lesson, student } = event;
      if (hasEnded(lesson, now)) return [];
      add(
        student.userId,
        "student",
        {
          ...lessonParams(lesson),
          fromGroup: event.fromGroup,
          oldStartsAt: event.oldStartsAt.toISOString(),
          note: event.note,
        },
        lessonLink(lesson.id),
        `replacement:${lesson.id}:${student.userId}`,
      );
      return out;
    }
    case "CALENDAR_FEED_REVOKED": {
      add(
        event.userId,
        event.audience,
        {},
        { kind: "calendarFeed" },
        `calendarFeed:${event.userId}`,
      );
      return out;
    }
    case "REPLACEMENT_REVIEW_PENDING": {
      for (const id of event.adminIds) {
        add(
          id,
          "admin",
          { count: 1 },
          { kind: "replacementReview" },
          "replacements:review",
          "replacements:review",
        );
      }
      return out;
    }
    case "AVAILABILITY_REQUEST_PENDING": {
      const { teacher } = event;
      for (const id of event.adminIds) {
        add(
          id,
          "admin",
          { teacher: teacher.name, count: 1 },
          { kind: "availability", teacherId: teacher.id },
          `availability:${teacher.id}`,
          `availability:${teacher.id}:pending`,
        );
      }
      return out;
    }
    case "AVAILABILITY_REQUEST_DECIDED": {
      add(
        event.userId,
        "teacher",
        { outcome: event.outcome, note: event.note },
        { kind: "availability", teacherId: event.teacherId },
        `availability:${event.teacherId}`,
      );
      return out;
    }
    case "TIMETABLE_PUBLISHED": {
      const { term } = event;
      for (const r of event.recipients) {
        add(
          r.userId,
          r.audience,
          {
            term: term.name,
            termStart: term.startDate,
            termEnd: term.endDate,
            firstStartsAt: r.firstStartsAt?.toISOString() ?? null,
          },
          {
            kind: "timetable",
            date: r.firstStartsAt
              ? toZonedDateTime(r.firstStartsAt, timeZone).date
              : term.startDate,
          },
          `term:${term.id}`,
        );
      }
      return out;
    }
    case "TIMETABLE_CHANGED": {
      const { term } = event;
      for (const r of event.recipients) {
        add(
          r.userId,
          r.audience,
          {
            term: term.name,
            ...r.counts,
            firstDate: r.firstDate,
            lastDate: r.lastDate,
          },
          { kind: "timetable", date: r.firstDate },
          `term:${term.id}`,
          `term:${term.id}:changed`,
        );
      }
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Coalescing (§2.5)
// ---------------------------------------------------------------------------

/** The parts of a stored notification coalescing may change. */
export type Coalescible = {
  type: NotificationType;
  audience: Audience;
  params: NotificationParams;
  link: NotificationLink | null;
};

const num = (value: unknown) => (typeof value === "number" ? value : 0);
const str = (value: unknown) => (typeof value === "string" ? value : null);

/**
 * Merges a new event into the recipient's unread notification with the same
 * `coalesceKey`. Returns the merged content, or null when the result says
 * nothing changed for the recipient (the row is then deleted).
 */
export function coalesce(
  existing: Coalescible,
  incoming: Coalescible,
  recipientId: string,
): Coalescible | null {
  switch (incoming.type) {
    case "LESSON_MOVED":
      // Newest time and room, but "was" stays what the reader last knew.
      return {
        ...incoming,
        params: {
          ...incoming.params,
          oldStartsAt:
            existing.params.oldStartsAt ?? incoming.params.oldStartsAt,
          oldEndsAt: existing.params.oldEndsAt ?? incoming.params.oldEndsAt,
          oldRoom:
            "oldRoom" in existing.params
              ? existing.params.oldRoom
              : incoming.params.oldRoom,
        },
      };
    case "SUBSTITUTE_ASSIGNED":
    case "SUBSTITUTE_REMOVED": {
      // `fromId` / `toId` are the lesson's substitute before the first and
      // after the last event. Same → the reader's picture didn't change.
      const fromId = str(existing.params.fromId);
      const toId = str(incoming.params.toId);
      if (fromId === toId) return null;
      // A substitute who is neither the one before nor the one after was
      // assigned and taken off again in between.
      if (
        incoming.audience === "substitute" &&
        recipientId !== fromId &&
        recipientId !== toId
      ) {
        return null;
      }
      return { ...incoming, params: { ...incoming.params, fromId, toId } };
    }
    case "TIMETABLE_CHANGED": {
      const a = existing.params;
      const b = incoming.params;
      const firstDate = minDate(str(a.firstDate), str(b.firstDate));
      return {
        ...incoming,
        params: {
          ...b,
          added: num(a.added) + num(b.added),
          cancelled: num(a.cancelled) + num(b.cancelled),
          moved: num(a.moved) + num(b.moved),
          teacherChanged: num(a.teacherChanged) + num(b.teacherChanged),
          firstDate,
          lastDate: maxDate(str(a.lastDate), str(b.lastDate)),
        },
        link: firstDate
          ? { kind: "timetable", date: firstDate }
          : incoming.link,
      };
    }
    case "REPLACEMENT_REVIEW_PENDING":
    case "AVAILABILITY_REQUEST_PENDING":
      return {
        ...incoming,
        params: {
          ...incoming.params,
          count: num(existing.params.count) + num(incoming.params.count),
        },
      };
    default:
      return incoming;
  }
}

const minDate = (a: string | null, b: string | null) =>
  a && b ? (a < b ? a : b) : (a ?? b);
const maxDate = (a: string | null, b: string | null) =>
  a && b ? (a > b ? a : b) : (a ?? b);

/** Unread rows a `LESSON_CANCELLED` supersedes for the same recipient. */
export function supersededBy(draft: NotificationDraft): string[] {
  if (draft.type !== "LESSON_CANCELLED" || draft.link?.kind !== "lesson") {
    return [];
  }
  const id = draft.link.lessonId;
  return [`lesson:${id}:moved`, `lesson:${id}:substitute`];
}

/**
 * Drops repeated `(recipient, subject, type)` drafts, keeping the first
 * (§2.5: de-duplicate in memory before coalescing). Callers list teachers
 * before students, so a teacher who is also an attendee keeps the teacher
 * copy.
 */
export function dedupeDrafts(
  drafts: readonly NotificationDraft[],
): NotificationDraft[] {
  const seen = new Set<string>();
  return drafts.filter((d) => {
    const key = `${d.recipientId}|${d.type}|${d.subject}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Bulk timetable changes (§2.3)
// ---------------------------------------------------------------------------

/** A lesson before or after a bulk change, as the summary needs it. */
export type LessonSnapshot = {
  id: string;
  termId: string;
  /**
   * `groupId|occurrenceDate` for generated lessons, so a slot split's old
   * and new lesson of one date read as the same lesson moved; null for
   * ad-hoc lessons.
   */
  occurrence: string | null;
  startsAt: Date;
  endsAt: Date;
  roomId: string | null;
  /** `User.id`s. */
  teacherId: string;
  substituteId: string | null;
  cancelled: boolean;
  attendees: readonly string[];
};

export type ChangeSummary = {
  userId: string;
  audience: "teacher" | "student";
  counts: ChangeCounts;
  firstDate: IsoDate;
  lastDate: IsoDate;
};

const peopleOf = (s: LessonSnapshot) => {
  const teachers = new Set([s.substituteId ?? s.teacherId, s.teacherId]);
  return { teachers, students: new Set(s.attendees) };
};

/**
 * Per person, how many of their not-ended lessons a bulk action added,
 * cancelled, moved (time or room) or gave another teacher, with the first
 * and last affected date (§2.3). `before` / `after` hold the affected
 * lessons; a lesson missing from `after` was deleted. A lesson that was
 * deleted or cancelled and one created for the same group and date are
 * the same lesson changed. A person counts on both sides of a change: the
 * old and the new teacher of a teacher change both get `teacherChanged`.
 */
export function summarizeLessonChanges(
  before: readonly LessonSnapshot[],
  after: readonly LessonSnapshot[],
  { now, timeZone }: { now: Date; timeZone: string },
): Map<string, ChangeSummary[]> {
  const beforeById = new Map(before.map((s) => [s.id, s]));
  const afterById = new Map(after.map((s) => [s.id, s]));
  const pairs: [LessonSnapshot | null, LessonSnapshot | null][] = [];

  // Pair by id first, then a vanished lesson with a new one of the same
  // occurrence (group and date). A group can have several lessons on one
  // date, so each occurrence keeps a list: a new lesson takes an identical
  // lost one first, then one with the same time, else the nearest start
  // (ties by id).
  const lostByOccurrence = new Map<string, LessonSnapshot[]>();
  const lost: LessonSnapshot[] = [];
  for (const b of [...before].sort(byId)) {
    const a = afterById.get(b.id) ?? null;
    if (a && !a.cancelled) {
      pairs.push([b, a]);
    } else if (!b.cancelled) {
      lost.push(b);
      if (b.occurrence) {
        const list = lostByOccurrence.get(b.occurrence) ?? [];
        list.push(b);
        lostByOccurrence.set(b.occurrence, list);
      }
    }
  }
  const created = [...after]
    .filter((a) => !beforeById.has(a.id) && !a.cancelled)
    .sort(byId);
  const matched = new Set<string>();
  const partner = new Map<string, LessonSnapshot>();
  const sameTime = (a: LessonSnapshot, b: LessonSnapshot) =>
    a.startsAt.getTime() === b.startsAt.getTime() &&
    a.endsAt.getTime() === b.endsAt.getTime();
  const identical = (a: LessonSnapshot, b: LessonSnapshot) =>
    sameTime(a, b) &&
    a.roomId === b.roomId &&
    a.teacherId === b.teacherId &&
    a.substituteId === b.substituteId;
  const gap = (a: LessonSnapshot, b: LessonSnapshot) =>
    Math.abs(a.startsAt.getTime() - b.startsAt.getTime());
  // Passes: identical lesson, then same time, then nearest start.
  const passes = [identical, sameTime, () => true];
  for (const fits of passes) {
    for (const a of created) {
      if (partner.has(a.id) || !a.occurrence) continue;
      const candidates = (lostByOccurrence.get(a.occurrence) ?? [])
        .filter((b) => !matched.has(b.id) && fits(a, b))
        .sort((x, y) => gap(a, x) - gap(a, y) || x.id.localeCompare(y.id));
      const b = candidates[0];
      if (!b) continue;
      matched.add(b.id);
      partner.set(a.id, b);
    }
  }
  for (const a of created) pairs.push([partner.get(a.id) ?? null, a]);
  for (const b of lost) if (!matched.has(b.id)) pairs.push([b, null]);

  const out = new Map<string, Map<string, ChangeSummary>>();
  const count = (
    userId: string,
    audience: "teacher" | "student",
    termId: string,
    kind: keyof ChangeCounts,
    startsAt: Date,
  ) => {
    const date = toZonedDateTime(startsAt, timeZone).date;
    let byTerm = out.get(termId);
    if (!byTerm) out.set(termId, (byTerm = new Map()));
    const key = `${userId}|${audience}`;
    let entry = byTerm.get(key);
    if (!entry) {
      entry = {
        userId,
        audience,
        counts: { added: 0, cancelled: 0, moved: 0, teacherChanged: 0 },
        firstDate: date,
        lastDate: date,
      };
      byTerm.set(key, entry);
    }
    entry.counts[kind]++;
    if (date < entry.firstDate) entry.firstDate = date;
    if (date > entry.lastDate) entry.lastDate = date;
  };

  for (const [b, a] of pairs) {
    const lesson = (a ?? b)!;
    // Only lessons that haven't ended on either side.
    const ended = [b, a].every(
      (s) => !s || s.endsAt.getTime() <= now.getTime(),
    );
    if (ended) continue;
    if (!b || b.cancelled) {
      const p = peopleOf(a!);
      for (const id of p.teachers)
        count(id, "teacher", a!.termId, "added", a!.startsAt);
      for (const id of p.students)
        count(id, "student", a!.termId, "added", a!.startsAt);
      continue;
    }
    if (!a) {
      const p = peopleOf(b);
      for (const id of p.teachers)
        count(id, "teacher", b.termId, "cancelled", b.startsAt);
      for (const id of p.students)
        count(id, "student", b.termId, "cancelled", b.startsAt);
      continue;
    }
    const moved =
      a.startsAt.getTime() !== b.startsAt.getTime() ||
      a.endsAt.getTime() !== b.endsAt.getTime() ||
      a.roomId !== b.roomId;
    const effectiveBefore = b.substituteId ?? b.teacherId;
    const effectiveAfter = a.substituteId ?? a.teacherId;
    const teacherChanged =
      effectiveBefore !== effectiveAfter || a.teacherId !== b.teacherId;
    if (!moved && !teacherChanged) continue;
    const pb = peopleOf(b);
    const pa = peopleOf(a);
    for (const id of new Set([...pb.teachers, ...pa.teachers])) {
      // A teacher on one side only lost or gained the lesson.
      const bothSides = pb.teachers.has(id) && pa.teachers.has(id);
      const kind = !bothSides
        ? "teacherChanged"
        : moved
          ? "moved"
          : "teacherChanged";
      count(id, "teacher", lesson.termId, kind, a.startsAt);
    }
    // Students only see who teaches, not who the regular teacher is.
    if (!moved && effectiveBefore === effectiveAfter) continue;
    for (const id of new Set([...pb.students, ...pa.students])) {
      count(
        id,
        "student",
        lesson.termId,
        moved ? "moved" : "teacherChanged",
        a.startsAt,
      );
    }
  }

  return new Map(
    [...out].map(([termId, byKey]) => [
      termId,
      [...byKey.values()].sort((x, y) =>
        x.userId === y.userId
          ? x.audience.localeCompare(y.audience)
          : x.userId.localeCompare(y.userId),
      ),
    ]),
  );
}

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

// ---------------------------------------------------------------------------
// Retention (§2.5)
// ---------------------------------------------------------------------------

/** Rows created at or before this instant are expired (invisible, purged). */
export function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000);
}

export function isExpired(createdAt: Date, now: Date): boolean {
  return createdAt.getTime() <= retentionCutoff(now).getTime();
}
