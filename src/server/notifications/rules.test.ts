import { describe, expect, it } from "vitest";

import { generateLessonOccurrences } from "@/server/scheduling/generate-lessons";
import {
  type ExistingLesson,
  planGroupTeacherChange,
  planLessonSync,
} from "@/server/scheduling/lesson-sync";
import { slot, TERM, TZ } from "@/server/scheduling/testing/fixtures";
import type { SlotInfo } from "@/server/scheduling/types";

import {
  coalesce,
  type Coalescible,
  dedupeDrafts,
  isExpired,
  type LessonFacts,
  type LessonSnapshot,
  NOTIFICATION_RETENTION_DAYS,
  type NotificationDraft,
  recipientsFor,
  retentionCutoff,
  summarizeLessonChanges,
  supersededBy,
} from "./rules";

const NOW = new Date("2026-10-20T10:00:00Z");
const ctx = { actorId: "admin", now: NOW, timeZone: TZ };

const lesson = (extra: Partial<LessonFacts> = {}): LessonFacts => ({
  id: "L1",
  groupName: "B1 Evening",
  lessonType: "GROUP",
  startsAt: new Date("2026-10-22T15:00:00Z"),
  endsAt: new Date("2026-10-22T16:30:00Z"),
  room: "Room 3",
  teacher: { userId: "tomas", name: "Tomas Horvat" },
  substitute: null,
  attendees: ["cara", "dan"],
  ...extra,
});

const who = (drafts: NotificationDraft[]) =>
  drafts.map((d) => `${d.recipientId}:${d.audience}`);

describe("recipientsFor", () => {
  it("LESSON_CANCELLED goes to the teachers and the attendees", () => {
    const drafts = recipientsFor(
      {
        type: "LESSON_CANCELLED",
        lesson: lesson({ substitute: { userId: "ana", name: "Ana Kral" } }),
        reason: "SCHOOL_CANCELLED",
      },
      ctx,
    );
    expect(who(drafts)).toEqual([
      "ana:teacher",
      "tomas:regular",
      "cara:student",
      "dan:student",
    ]);
    expect(drafts[0]).toMatchObject({
      type: "LESSON_CANCELLED",
      params: {
        group: "B1 Evening",
        reason: "SCHOOL_CANCELLED",
        lessonType: "GROUP",
      },
      link: { kind: "lesson", lessonId: "L1" },
      coalesceKey: null,
    });
  });

  it("never notifies the actor", () => {
    const drafts = recipientsFor(
      {
        type: "LESSON_CANCELLED",
        lesson: lesson(),
        reason: "SCHOOL_CANCELLED",
      },
      { ...ctx, actorId: "tomas" },
    );
    expect(who(drafts)).toEqual(["cara:student", "dan:student"]);
  });

  it("notifies nobody about a lesson that has ended", () => {
    const ended = lesson({
      startsAt: new Date("2026-10-19T15:00:00Z"),
      endsAt: new Date("2026-10-19T16:30:00Z"),
    });
    for (const event of [
      { type: "LESSON_CANCELLED" as const, lesson: ended, reason: "X" },
      {
        type: "SUBSTITUTE_ASSIGNED" as const,
        lesson: { ...ended, substitute: { userId: "ana", name: "Ana" } },
        previous: null,
      },
      {
        type: "ABSENCE_REPORTED" as const,
        lesson: ended,
        student: { userId: "cara", name: "Cara" },
        withCredit: true,
        byAdmin: true,
      },
    ]) {
      expect(recipientsFor(event, ctx)).toEqual([]);
    }
  });

  it("LESSON_MOVED keeps the old time and room and coalesces per lesson", () => {
    const drafts = recipientsFor(
      {
        type: "LESSON_MOVED",
        lesson: lesson({ id: "new" }),
        old: {
          startsAt: new Date("2026-10-21T15:00:00Z"),
          endsAt: new Date("2026-10-21T16:30:00Z"),
          room: "Room 1",
        },
      },
      ctx,
    );
    expect(who(drafts)).toEqual([
      "tomas:teacher",
      "cara:student",
      "dan:student",
    ]);
    expect(drafts[0].params).toMatchObject({
      oldStartsAt: "2026-10-21T15:00:00.000Z",
      oldRoom: "Room 1",
      room: "Room 3",
    });
    expect(drafts[0].coalesceKey).toBe("lesson:new:moved");
    expect(drafts[0].link).toEqual({ kind: "lesson", lessonId: "new" });
  });

  it("a student's own reschedule tells only the teachers", () => {
    const drafts = recipientsFor(
      {
        type: "LESSON_MOVED",
        lesson: lesson({ lessonType: "ONE_ON_ONE", attendees: ["olga"] }),
        old: { startsAt: NOW, endsAt: NOW, room: null },
        teachersOnly: true,
      },
      { ...ctx, actorId: "olga" },
    );
    expect(who(drafts)).toEqual(["tomas:teacher"]);
  });

  it("SUBSTITUTE_ASSIGNED: substitute, regular teacher and attendees", () => {
    const drafts = recipientsFor(
      {
        type: "SUBSTITUTE_ASSIGNED",
        lesson: lesson({ substitute: { userId: "ana", name: "Ana Kral" } }),
        previous: null,
      },
      ctx,
    );
    expect(who(drafts)).toEqual([
      "ana:substitute",
      "tomas:regular",
      "cara:student",
      "dan:student",
    ]);
    expect(drafts[0].params).toMatchObject({
      substitute: "Ana Kral",
      teacher: "Tomas Horvat",
      fromId: null,
      toId: "ana",
    });
    expect(drafts[0].coalesceKey).toBe("lesson:L1:substitute");
  });

  it("students aren't told about a substitute once the lesson started", () => {
    const started = lesson({
      startsAt: new Date("2026-10-20T09:30:00Z"),
      endsAt: new Date("2026-10-20T11:00:00Z"),
      substitute: { userId: "ana", name: "Ana" },
    });
    expect(
      who(
        recipientsFor(
          { type: "SUBSTITUTE_ASSIGNED", lesson: started, previous: null },
          ctx,
        ),
      ),
    ).toEqual(["ana:substitute", "tomas:regular"]);
    expect(
      who(
        recipientsFor(
          {
            type: "SUBSTITUTE_REMOVED",
            lesson: { ...started, substitute: null },
            removed: { userId: "ana", name: "Ana" },
            next: null,
          },
          ctx,
        ),
      ),
    ).toEqual(["ana:substitute", "tomas:regular"]);
  });

  it("SUBSTITUTE_REMOVED on a change goes to the previous substitute only", () => {
    const drafts = recipientsFor(
      {
        type: "SUBSTITUTE_REMOVED",
        lesson: lesson({ substitute: { userId: "eva", name: "Eva" } }),
        removed: { userId: "ana", name: "Ana" },
        next: { userId: "eva", name: "Eva" },
      },
      ctx,
    );
    expect(who(drafts)).toEqual(["ana:substitute"]);
    // The removed substitute can't open the lesson any more: their week.
    expect(drafts[0].link).toEqual({ kind: "timetable", date: "2026-10-22" });
    expect(drafts[0].params).toMatchObject({ fromId: "ana", toId: "eva" });
  });

  it("ABSENCE_REPORTED: the effective teacher, and the student when an admin reported it", () => {
    const covered = lesson({ substitute: { userId: "ana", name: "Ana" } });
    const event = {
      type: "ABSENCE_REPORTED" as const,
      lesson: covered,
      student: { userId: "cara", name: "Cara Novak" },
      withCredit: true,
    };
    const byStudent = recipientsFor(
      { ...event, byAdmin: false },
      { ...ctx, actorId: "cara" },
    );
    expect(who(byStudent)).toEqual(["ana:teacher"]);
    expect(byStudent[0].params.student).toBe("Cara Novak");

    const byAdmin = recipientsFor({ ...event, byAdmin: true }, ctx);
    expect(who(byAdmin)).toEqual(["ana:teacher", "cara:student"]);
    // No student name in a student's notification (§2.4).
    expect(byAdmin[1].params).not.toHaveProperty("student");
    expect(byAdmin[1].params.withCredit).toBe("yes");
    expect(byAdmin[1].link).toEqual({ kind: "absences" });
  });

  it("REPLACEMENT_BOOKED: the student only when an admin booked it", () => {
    const event = {
      type: "REPLACEMENT_BOOKED" as const,
      lesson: lesson(),
      student: { userId: "olga", name: "Olga" },
      fromGroup: "B1 Morning",
    };
    expect(
      who(
        recipientsFor(
          { ...event, byAdmin: false },
          { ...ctx, actorId: "olga" },
        ),
      ),
    ).toEqual(["tomas:teacher"]);
    const byAdmin = recipientsFor({ ...event, byAdmin: true }, ctx);
    expect(who(byAdmin)).toEqual(["tomas:teacher", "olga:student"]);
    expect(byAdmin[1].params).not.toHaveProperty("student");
  });

  it("REPLACEMENT_ENDED: the student unless they did it, never for a move", () => {
    const base = {
      type: "REPLACEMENT_ENDED" as const,
      lesson: lesson(),
      student: { userId: "olga", name: "Olga" },
      creditBack: true,
      note: "Group is full",
    };
    const rejected = recipientsFor(
      { ...base, outcome: "rejected", byStudent: false },
      ctx,
    );
    expect(who(rejected)).toEqual(["tomas:teacher", "olga:student"]);
    expect(rejected[0].params).not.toHaveProperty("note");
    expect(rejected[1].params).toMatchObject({
      note: "Group is full",
      creditBack: "yes",
    });
    expect(
      who(
        recipientsFor(
          { ...base, outcome: "cancelled", byStudent: true },
          { ...ctx, actorId: "olga" },
        ),
      ),
    ).toEqual(["tomas:teacher"]);
    expect(
      who(recipientsFor({ ...base, outcome: "moved", byStudent: false }, ctx)),
    ).toEqual(["tomas:teacher"]);
    expect(
      who(
        recipientsFor(
          { ...base, outcome: "cancelled", byStudent: false, only: "student" },
          ctx,
        ),
      ),
    ).toEqual(["olga:student"]);
  });

  it("REPLACEMENT_REVIEW_PENDING: every admin, one coalesced item", () => {
    const drafts = recipientsFor(
      { type: "REPLACEMENT_REVIEW_PENDING", adminIds: ["a1", "a2"] },
      { ...ctx, actorId: "olga" },
    );
    expect(who(drafts)).toEqual(["a1:admin", "a2:admin"]);
    expect(drafts[0]).toMatchObject({
      params: { count: 1 },
      coalesceKey: "replacements:review",
      link: { kind: "replacementReview" },
    });
  });

  it("TIMETABLE_PUBLISHED links to each person's first lesson week", () => {
    const drafts = recipientsFor(
      {
        type: "TIMETABLE_PUBLISHED",
        term: {
          id: "T",
          name: "Autumn",
          startDate: "2026-10-12",
          endDate: "2026-12-18",
        },
        recipients: [
          {
            userId: "tomas",
            audience: "teacher",
            firstStartsAt: new Date("2026-10-21T15:00:00Z"),
          },
          { userId: "cara", audience: "student", firstStartsAt: null },
        ],
      },
      ctx,
    );
    expect(drafts.map((d) => d.link)).toEqual([
      { kind: "timetable", date: "2026-10-21" },
      { kind: "timetable", date: "2026-10-12" },
    ]);
    expect(drafts[1].params.firstStartsAt).toBeNull();
  });
});

describe("dedupeDrafts", () => {
  it("keeps the first draft per recipient, type and subject", () => {
    // Tomas is regular teacher and (oddly) also an attendee of the lesson.
    const drafts = recipientsFor(
      {
        type: "LESSON_CANCELLED",
        lesson: lesson({ attendees: ["tomas", "cara"] }),
        reason: "X",
      },
      ctx,
    );
    expect(who(dedupeDrafts(drafts))).toEqual([
      "tomas:teacher",
      "cara:student",
    ]);
  });
});

describe("coalesce", () => {
  const moved = (params: Record<string, string | null>): Coalescible => ({
    type: "LESSON_MOVED",
    audience: "student",
    params,
    link: null,
  });

  it("LESSON_MOVED keeps the oldest 'was' and the newest time", () => {
    const merged = coalesce(
      moved({
        oldStartsAt: "A",
        oldEndsAt: "A2",
        oldRoom: "R1",
        startsAt: "B",
        room: "R2",
      }),
      moved({
        oldStartsAt: "B",
        oldEndsAt: "B2",
        oldRoom: "R2",
        startsAt: "C",
        room: "R3",
      }),
      "cara",
    );
    expect(merged?.params).toMatchObject({
      oldStartsAt: "A",
      oldEndsAt: "A2",
      oldRoom: "R1",
      startsAt: "C",
      room: "R3",
    });
  });

  const sub = (
    type: "SUBSTITUTE_ASSIGNED" | "SUBSTITUTE_REMOVED",
    audience: "regular" | "substitute" | "student",
    fromId: string | null,
    toId: string | null,
  ): Coalescible => ({ type, audience, params: { fromId, toId }, link: null });

  it("assigned then removed for the same substitute deletes the row", () => {
    expect(
      coalesce(
        sub("SUBSTITUTE_ASSIGNED", "regular", null, "ana"),
        sub("SUBSTITUTE_REMOVED", "regular", "ana", null),
        "tomas",
      ),
    ).toBeNull();
    expect(
      coalesce(
        sub("SUBSTITUTE_ASSIGNED", "substitute", null, "ana"),
        sub("SUBSTITUTE_REMOVED", "substitute", "ana", null),
        "ana",
      ),
    ).toBeNull();
  });

  it("a changed substitute keeps one item with the newest substitute", () => {
    const merged = coalesce(
      sub("SUBSTITUTE_ASSIGNED", "regular", null, "ana"),
      sub("SUBSTITUTE_ASSIGNED", "regular", "ana", "eva"),
      "tomas",
    );
    expect(merged).toMatchObject({
      type: "SUBSTITUTE_ASSIGNED",
      params: { fromId: null, toId: "eva" },
    });
    // Ana was assigned and then replaced: nothing changed for her.
    expect(
      coalesce(
        sub("SUBSTITUTE_ASSIGNED", "substitute", null, "ana"),
        sub("SUBSTITUTE_REMOVED", "substitute", "ana", "eva"),
        "ana",
      ),
    ).toBeNull();
  });

  it("TIMETABLE_CHANGED adds the counts and widens the dates", () => {
    const changed = (
      counts: number[],
      from: string,
      to: string,
    ): Coalescible => ({
      type: "TIMETABLE_CHANGED",
      audience: "teacher",
      params: {
        term: "Autumn",
        added: counts[0],
        cancelled: counts[1],
        moved: counts[2],
        teacherChanged: counts[3],
        firstDate: from,
        lastDate: to,
      },
      link: { kind: "timetable", date: from },
    });
    const merged = coalesce(
      changed([1, 0, 2, 0], "2026-11-03", "2026-11-10"),
      changed([0, 3, 0, 1], "2026-10-27", "2026-11-05"),
      "tomas",
    );
    expect(merged?.params).toMatchObject({
      added: 1,
      cancelled: 3,
      moved: 2,
      teacherChanged: 1,
      firstDate: "2026-10-27",
      lastDate: "2026-11-10",
    });
    expect(merged?.link).toEqual({ kind: "timetable", date: "2026-10-27" });
  });

  it("REPLACEMENT_REVIEW_PENDING adds one per booking", () => {
    const pending = (count: number): Coalescible => ({
      type: "REPLACEMENT_REVIEW_PENDING",
      audience: "admin",
      params: { count },
      link: { kind: "replacementReview" },
    });
    expect(coalesce(pending(3), pending(1), "a1")?.params.count).toBe(4);
  });

  it("LESSON_CANCELLED supersedes unread moved and substitute items", () => {
    const [draft] = recipientsFor(
      { type: "LESSON_CANCELLED", lesson: lesson(), reason: "X" },
      ctx,
    );
    expect(supersededBy(draft)).toEqual([
      "lesson:L1:moved",
      "lesson:L1:substitute",
    ]);
    const [other] = recipientsFor(
      { type: "REPLACEMENT_REVIEW_PENDING", adminIds: ["a1"] },
      ctx,
    );
    expect(supersededBy(other)).toEqual([]);
  });
});

describe("summarizeLessonChanges", () => {
  // Users behind the scheduling ids: teachers t1/t2, students of g1.
  const users: Record<string, string> = { t1: "u-t1", t2: "u-t2" };
  const attendees = ["u-s1", "u-s2"];
  const SUMMARY_NOW = new Date("2026-10-12T00:00:00Z");

  function stored(slots: SlotInfo[]): ExistingLesson[] {
    return generateLessonOccurrences({
      slots,
      term: TERM,
      holidays: [],
      timeZone: TZ,
    }).map((o) => ({
      id: `${o.timetableSlotId}@${o.date}`,
      termId: TERM.id,
      timetableSlotId: o.timetableSlotId,
      occurrenceDate: o.date,
      groupId: o.groupId,
      teacherId: o.teacherId,
      substituteTeacherId: null,
      roomId: o.roomId,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      status: "SCHEDULED",
      hasDependents: false,
    }));
  }

  const snapshot = (l: ExistingLesson): LessonSnapshot => ({
    id: l.id,
    termId: l.termId,
    occurrence: l.occurrenceDate ? `${l.groupId}|${l.occurrenceDate}` : null,
    startsAt: l.startsAt,
    endsAt: l.endsAt,
    roomId: l.roomId,
    teacherId: users[l.teacherId],
    substituteId: l.substituteTeacherId ? users[l.substituteTeacherId] : null,
    cancelled: l.status === "CANCELLED",
    attendees,
  });

  it("counts a slot moved to another time as moved, once per lesson", () => {
    const monday = slot("s1");
    const lessons = stored([monday]);
    // End the Monday slot from 2026-10-26 and continue on Tuesday.
    const ended = { ...monday, validUntil: "2026-10-25" };
    const tuesday = {
      ...monday,
      id: "s2",
      weekday: 2,
      validFrom: "2026-10-26",
    };
    const plan = planLessonSync({
      term: TERM,
      slots: [ended, tuesday],
      holidays: [],
      lessons,
      timeZone: TZ,
      from: "2026-10-26",
      now: SUMMARY_NOW,
    });
    expect(plan.remove).toHaveLength(2);
    expect(plan.create).toHaveLength(2);
    const before = lessons
      .filter((l) => plan.remove.includes(l.id))
      .map(snapshot);
    const after = plan.create.map((o) =>
      snapshot({
        id: `${o.timetableSlotId}@${o.date}`,
        termId: TERM.id,
        timetableSlotId: o.timetableSlotId,
        occurrenceDate: o.date,
        groupId: o.groupId,
        teacherId: o.teacherId,
        substituteTeacherId: null,
        roomId: o.roomId,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
        status: "SCHEDULED",
        hasDependents: false,
      }),
    );
    // Different dates: no pairing, so 2 cancelled and 2 added for everyone.
    const summary = summarizeLessonChanges(before, after, {
      now: SUMMARY_NOW,
      timeZone: TZ,
    });
    const people = summary.get(TERM.id)!;
    expect(people.map((p) => `${p.userId}:${p.audience}`)).toEqual([
      "u-s1:student",
      "u-s2:student",
      "u-t1:teacher",
    ]);
    expect(people[2]).toMatchObject({
      counts: { added: 2, cancelled: 2, moved: 0, teacherChanged: 0 },
      firstDate: "2026-10-26",
      lastDate: "2026-11-03",
    });
  });

  it("pairs a lesson replaced on the same date as moved", () => {
    const before: LessonSnapshot = {
      id: "old",
      termId: "T",
      occurrence: "g1|2026-10-26",
      startsAt: new Date("2026-10-26T08:00:00Z"),
      endsAt: new Date("2026-10-26T09:30:00Z"),
      roomId: "r1",
      teacherId: "u-t1",
      substituteId: null,
      cancelled: false,
      attendees,
    };
    const after = {
      ...before,
      id: "new",
      startsAt: new Date("2026-10-26T10:00:00Z"),
      endsAt: new Date("2026-10-26T11:30:00Z"),
    };
    const people = summarizeLessonChanges([before], [after], {
      now: SUMMARY_NOW,
      timeZone: TZ,
    }).get("T")!;
    expect(
      people.every((p) => p.counts.moved === 1 && p.counts.added === 0),
    ).toBe(true);
  });

  it("two lessons of a group on one date, both recreated unchanged: nothing to report", () => {
    const lesson = (id: string, hour: number): LessonSnapshot => ({
      id,
      termId: "T",
      occurrence: "g1|2026-10-26",
      startsAt: new Date(`2026-10-26T${String(hour).padStart(2, "0")}:00:00Z`),
      endsAt: new Date(
        `2026-10-26T${String(hour + 1).padStart(2, "0")}:30:00Z`,
      ),
      roomId: "r1",
      teacherId: "u-t1",
      substituteId: null,
      cancelled: false,
      attendees,
    });
    const ctx = { now: SUMMARY_NOW, timeZone: TZ };
    // Ids sort so that a greedy pairing would cross them.
    const before = [lesson("a", 7), lesson("b", 12)];
    const after = [lesson("d", 7), lesson("c", 12)];
    expect(summarizeLessonChanges(before, after, ctx).size).toBe(0);
    // One of them moved: exactly one move, nothing added or cancelled.
    const moved = [lesson("d", 7), { ...lesson("c", 12), roomId: "r2" }];
    const people = summarizeLessonChanges(before, moved, ctx).get("T")!;
    expect(people.map((p) => p.counts)).toEqual(
      people.map(() => ({
        added: 0,
        cancelled: 0,
        moved: 1,
        teacherChanged: 0,
      })),
    );
  });

  it("deleting and identically recreating any timetable reports nothing", () => {
    // Property-style: random groups, dates and up to three lessons a day.
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let run = 0; run < 50; run++) {
      const before: LessonSnapshot[] = [];
      for (let i = 0; i < 12; i++) {
        const day = 26 + rand(4);
        const hour = 7 + rand(10);
        before.push({
          id: `b${run}-${i}`,
          termId: "T",
          occurrence: `g${rand(3)}|2026-10-${day}`,
          startsAt: new Date(Date.UTC(2026, 9, day, hour)),
          endsAt: new Date(Date.UTC(2026, 9, day, hour + 1)),
          roomId: `r${rand(2)}`,
          teacherId: `u-t${rand(3)}`,
          substituteId: null,
          cancelled: false,
          attendees,
        });
      }
      const after = before.map((b, i) => ({
        ...b,
        id: `a${run}-${(i * 7) % 12}`,
      }));
      expect(
        summarizeLessonChanges(before, after, {
          now: SUMMARY_NOW,
          timeZone: TZ,
        }).size,
      ).toBe(0);
    }
  });

  it("a teacher change counts for the old and the new teacher", () => {
    const s1 = slot("s1");
    const lessons = stored([s1]);
    const plan = planGroupTeacherChange({
      slots: [s1],
      lessons,
      oldTeacherId: "t1",
      newTeacherId: "t2",
      from: "2026-10-26",
      now: SUMMARY_NOW,
      timeZone: TZ,
    });
    const changed = new Set(
      plan.repoint.filter((r) => r.setTeacher).map((r) => r.lessonId),
    );
    // Mondays 26 Oct and 2 Nov.
    expect(changed.size).toBe(2);
    const before = lessons.filter((l) => changed.has(l.id)).map(snapshot);
    const after = before.map((s) => ({ ...s, teacherId: "u-t2" }));
    const people = summarizeLessonChanges(before, after, {
      now: SUMMARY_NOW,
      timeZone: TZ,
    }).get(TERM.id)!;
    const byUser = Object.fromEntries(people.map((p) => [p.userId, p.counts]));
    expect(byUser["u-t1"]).toEqual({
      added: 0,
      cancelled: 0,
      moved: 0,
      teacherChanged: 2,
    });
    expect(byUser["u-t2"]).toEqual({
      added: 0,
      cancelled: 0,
      moved: 0,
      teacherChanged: 2,
    });
    expect(byUser["u-s1"].teacherChanged).toBe(2);
  });

  it("leaves out lessons that have ended and unchanged ones", () => {
    const s: LessonSnapshot = {
      id: "x",
      termId: "T",
      occurrence: null,
      startsAt: new Date("2026-10-01T08:00:00Z"),
      endsAt: new Date("2026-10-01T09:00:00Z"),
      roomId: "r1",
      teacherId: "u-t1",
      substituteId: null,
      cancelled: false,
      attendees,
    };
    expect(
      summarizeLessonChanges([s], [], { now: SUMMARY_NOW, timeZone: TZ }).size,
    ).toBe(0);
    const future = {
      ...s,
      startsAt: new Date("2026-10-30T08:00:00Z"),
      endsAt: new Date("2026-10-30T09:00:00Z"),
    };
    expect(
      summarizeLessonChanges([future], [future], {
        now: SUMMARY_NOW,
        timeZone: TZ,
      }).size,
    ).toBe(0);
  });

  it("a cancelled lesson counts as cancelled and a restored one as added", () => {
    const live: LessonSnapshot = {
      id: "x",
      termId: "T",
      occurrence: "g1|2026-10-30",
      startsAt: new Date("2026-10-30T08:00:00Z"),
      endsAt: new Date("2026-10-30T09:00:00Z"),
      roomId: "r1",
      teacherId: "u-t1",
      substituteId: "u-t2",
      cancelled: false,
      attendees: ["u-s1"],
    };
    const gone = summarizeLessonChanges(
      [live],
      [{ ...live, cancelled: true }],
      { now: SUMMARY_NOW, timeZone: TZ },
    ).get("T")!;
    // The substitute and the regular teacher both lose the lesson.
    expect(gone.map((p) => `${p.userId}:${p.counts.cancelled}`)).toEqual([
      "u-s1:1",
      "u-t1:1",
      "u-t2:1",
    ]);
    const back = summarizeLessonChanges(
      [{ ...live, cancelled: true }],
      [live],
      { now: SUMMARY_NOW, timeZone: TZ },
    ).get("T")!;
    expect(back.every((p) => p.counts.added === 1)).toBe(true);
  });
});

describe("retention", () => {
  it("expires rows 90 days after they were created", () => {
    expect(NOTIFICATION_RETENTION_DAYS).toBe(90);
    const cutoff = retentionCutoff(NOW);
    expect(cutoff.toISOString()).toBe("2026-07-22T10:00:00.000Z");
    expect(isExpired(cutoff, NOW)).toBe(true);
    expect(isExpired(new Date(cutoff.getTime() + 1), NOW)).toBe(false);
  });
});
