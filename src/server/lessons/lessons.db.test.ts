// Lesson log, lesson list and internal notes against a real Postgres
// (lessons.md §2, §5, §11). Opt-in, like the other DB tests: set
// SCHEDULING_TEST_DATABASE_URL to a migrated database (never your dev
// database; the test creates and deletes its own schools).

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { createPgAdapter } from "@/lib/pg-adapter";
import { AdminError } from "@/server/admin/result";
import { scopeToSchool } from "@/server/db/school-scope";
import {
  createLessonNote,
  deleteLessonNote,
  loadEarlierNotes,
  loadLessonNotes,
  TeacherNoteAccessError,
  updateLessonNote,
} from "@/server/notes/teacher-notes";
import type { SchoolDb } from "@/server/timetable/service";

import { teacherProfileId } from "./access";
import {
  listTeacherLessons,
  loadTeacherLesson,
  loadTeacherTodo,
  saveLessonLog,
} from "./teacher";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
const TZ = "Europe/Bratislava";
const NOW = new Date("2026-10-20T12:00:00Z");
const at = (iso: string) => new Date(iso);

describe.skipIf(!url)("lesson log & internal notes (database)", () => {
  let client: PrismaClient;
  let db: SchoolDb;
  let otherDb: SchoolDb;
  let schoolId = "";
  const schools: string[] = [];
  const users: string[] = [];
  const ids = {
    teacherA: randomUUID(),
    teacherB: randomUUID(),
    teacherC: randomUUID(),
    current: randomUUID(),
    leaver: randomUUID(),
    group: randomUUID(),
    otherGroup: randomUUID(),
    term: randomUUID(),
    draftTerm: randomUUID(),
  };
  // Lessons of `group`, taught by A; B substitutes `substituted`.
  const lessons = {
    first: randomUUID(), // Mon 13 Oct, past
    substituted: randomUUID(), // Wed 15 Oct, past, B substitutes
    cancelled: randomUUID(), // Mon 20 Oct 10:00, cancelled
    upcoming: randomUUID(), // Wed 22 Oct, future
    otherGroup: randomUUID(), // C's lesson
    draft: randomUUID(), // A's lesson in an unpublished term
    foreign: randomUUID(), // other school
  };

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: createPgAdapter(url),
    });
    const suffix = randomUUID().slice(0, 8);
    const school = await client.school.create({
      data: {
        name: `Lessons ${suffix}`,
        slug: `lessons-${suffix}`,
        timezone: TZ,
      },
    });
    const other = await client.school.create({
      data: {
        name: `Other ${suffix}`,
        slug: `lessons-o-${suffix}`,
        timezone: TZ,
      },
    });
    schools.push(school.id, other.id);
    schoolId = school.id;
    db = scopeToSchool(client, schoolId);
    otherDb = scopeToSchool(client, other.id);

    const person = async (
      name: string,
      role: "TEACHER" | "STUDENT" | "ADMIN",
      school = schoolId,
    ) => {
      const user = await client.user.create({
        data: { name, email: `${name.toLowerCase()}-${suffix}@example.test` },
      });
      users.push(user.id);
      await client.membership.create({
        data: { schoolId: school, userId: user.id, role },
      });
      return user.id;
    };
    const teacherUsers = {
      A: await person("Anna", "TEACHER"),
      B: await person("Bob", "TEACHER"),
      C: await person("Cyril", "TEACHER"),
    };
    await client.teacherProfile.createMany({
      data: [
        { id: ids.teacherA, schoolId, userId: teacherUsers.A },
        { id: ids.teacherB, schoolId, userId: teacherUsers.B },
        { id: ids.teacherC, schoolId, userId: teacherUsers.C },
      ],
    });
    await client.studentProfile.createMany({
      data: [
        { id: ids.current, schoolId, userId: await person("Cara", "STUDENT") },
        { id: ids.leaver, schoolId, userId: await person("Leo", "STUDENT") },
      ],
    });
    const level = await client.level.create({
      data: { schoolId, code: "B1", name: "B1", rank: 1 },
    });
    await client.group.createMany({
      data: [
        {
          id: ids.group,
          schoolId,
          levelId: level.id,
          type: "GROUP",
          name: "B1 Evening",
          capacity: 8,
        },
        {
          id: ids.otherGroup,
          schoolId,
          levelId: level.id,
          type: "GROUP",
          name: "B1 Late",
          capacity: 8,
        },
      ],
    });
    await client.groupMembership.createMany({
      data: [
        {
          schoolId,
          groupId: ids.group,
          studentId: ids.current,
          joinedAt: at("2026-09-01T00:00:00Z"),
        },
        {
          schoolId,
          groupId: ids.group,
          studentId: ids.leaver,
          joinedAt: at("2026-09-01T00:00:00Z"),
          leftAt: at("2026-10-16T00:00:00Z"),
        },
      ],
    });
    await client.term.createMany({
      data: [
        {
          id: ids.term,
          schoolId,
          name: "Autumn",
          startDate: at("2026-09-14T00:00:00Z"),
          endDate: at("2027-01-29T00:00:00Z"),
          timetablePublishedAt: at("2026-09-01T00:00:00Z"),
        },
        {
          id: ids.draftTerm,
          schoolId,
          name: "Spring",
          startDate: at("2027-02-01T00:00:00Z"),
          endDate: at("2027-06-30T00:00:00Z"),
        },
      ],
    });
    const lesson = (id: string, start: string, end: string, extra = {}) => ({
      id,
      schoolId,
      termId: ids.term,
      groupId: ids.group,
      teacherId: ids.teacherA,
      startsAt: at(start),
      endsAt: at(end),
      ...extra,
    });
    await client.lesson.createMany({
      data: [
        lesson(lessons.first, "2026-10-13T15:00:00Z", "2026-10-13T16:30:00Z"),
        lesson(
          lessons.substituted,
          "2026-10-15T15:00:00Z",
          "2026-10-15T16:30:00Z",
          {
            substituteTeacherId: ids.teacherB,
          },
        ),
        lesson(
          lessons.cancelled,
          "2026-10-20T08:00:00Z",
          "2026-10-20T09:30:00Z",
          {
            status: "CANCELLED",
            cancelReason: "HOLIDAY",
          },
        ),
        lesson(
          lessons.upcoming,
          "2026-10-22T15:00:00Z",
          "2026-10-22T16:30:00Z",
        ),
        lesson(
          lessons.otherGroup,
          "2026-10-14T15:00:00Z",
          "2026-10-14T16:30:00Z",
          {
            groupId: ids.otherGroup,
            teacherId: ids.teacherC,
          },
        ),
        lesson(lessons.draft, "2027-02-02T15:00:00Z", "2027-02-02T16:30:00Z", {
          termId: ids.draftTerm,
        }),
      ],
    });

    // The other school: a teacher with a lesson.
    const foreignTeacher = randomUUID();
    await client.teacherProfile.create({
      data: {
        id: foreignTeacher,
        schoolId: other.id,
        userId: await person("Zed", "TEACHER", other.id),
      },
    });
    const otherLevel = await client.level.create({
      data: { schoolId: other.id, code: "A1", name: "A1", rank: 1 },
    });
    const otherGroup = await client.group.create({
      data: {
        schoolId: other.id,
        levelId: otherLevel.id,
        type: "GROUP",
        name: "Z",
        capacity: 4,
      },
    });
    const otherTerm = await client.term.create({
      data: {
        schoolId: other.id,
        name: "Z",
        startDate: at("2026-09-14T00:00:00Z"),
        endDate: at("2027-01-29T00:00:00Z"),
        timetablePublishedAt: at("2026-09-01T00:00:00Z"),
      },
    });
    await client.lesson.create({
      data: {
        id: lessons.foreign,
        schoolId: other.id,
        termId: otherTerm.id,
        groupId: otherGroup.id,
        teacherId: foreignTeacher,
        startsAt: at("2026-10-13T15:00:00Z"),
        endsAt: at("2026-10-13T16:30:00Z"),
      },
    });
  });

  afterAll(async () => {
    if (!client) return;
    await client.teacherNote.deleteMany({
      where: { schoolId: { in: schools } },
    });
    await client.lessonLog.deleteMany({ where: { schoolId: { in: schools } } });
    await client.lesson.deleteMany({ where: { schoolId: { in: schools } } });
    await client.school.deleteMany({ where: { id: { in: schools } } });
    await client.user.deleteMany({ where: { id: { in: users } } });
    await client.$disconnect();
  });

  const load = (teacherId: string | null, lessonId: string) =>
    loadTeacherLesson(db, teacherId, lessonId, NOW, TZ);

  const log = (
    teacherId: string,
    lessonId: string,
    content: string | null,
    homework: string | null,
    expectedUpdatedAt: string | null,
  ) =>
    saveLessonLog(
      db,
      schoolId,
      teacherId,
      { lessonId, content, homework, expectedUpdatedAt },
      NOW,
    );

  const errorKey = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof AdminError) return error.error.key;
      throw error;
    }
    return null;
  };

  describe("who can open a lesson", () => {
    it("resolves the teacher's profile from their user id", async () => {
      const profile = await client.teacherProfile.findUniqueOrThrow({
        where: { id: ids.teacherA },
      });
      expect(await teacherProfileId(db, profile.userId)).toBe(ids.teacherA);
      expect(await teacherProfileId(otherDb, profile.userId)).toBeNull();
    });

    it("lets the regular teacher and the substitute in, both with full rights", async () => {
      expect((await load(ids.teacherA, lessons.first))?.relation).toBe(
        "regular",
      );
      const sub = await load(ids.teacherB, lessons.substituted);
      expect(sub?.relation).toBe("substituting");
      expect(sub?.teacherName).toBe("Anna");
      const regular = await load(ids.teacherA, lessons.substituted);
      expect(regular?.relation).toBe("covered");
      expect(regular?.substituteName).toBe("Bob");
    });

    it("returns nothing (→ 404) for any other lesson", async () => {
      expect(await load(ids.teacherB, lessons.first)).toBeNull();
      expect(await load(ids.teacherC, lessons.first)).toBeNull();
      expect(await load(ids.teacherA, lessons.otherGroup)).toBeNull();
      expect(await load(ids.teacherA, lessons.draft)).toBeNull();
      expect(await load(ids.teacherA, lessons.foreign)).toBeNull();
      expect(await load(ids.teacherA, "not-a-uuid")).toBeNull();
      expect(await load(null, lessons.first)).toBeNull();
    });
  });

  describe("lesson page", () => {
    it("shows badge, lock, neighbours and current students", async () => {
      const page = await load(ids.teacherA, lessons.substituted);
      expect(page).toMatchObject({
        date: "2026-10-15",
        startMinute: 17 * 60,
        endMinute: 18 * 60 + 30,
        badge: "noLog",
        lock: null,
        previousLessonId: lessons.first,
        nextLessonId: lessons.cancelled,
        students: [{ id: ids.current, name: "Cara" }],
      });
      // B can only step through lessons they substitute.
      const sub = await load(ids.teacherB, lessons.substituted);
      expect(sub?.previousLessonId).toBeNull();
      expect(sub?.nextLessonId).toBeNull();
      expect((await load(ids.teacherA, lessons.upcoming))?.lock).toBe(
        "notStarted",
      );
      expect(await load(ids.teacherA, lessons.cancelled)).toMatchObject({
        badge: "cancelled",
        lock: "cancelled",
      });
    });
  });

  describe("saving the lesson log", () => {
    it("creates, updates, detects conflicts and removes", async () => {
      const created = await log(
        ids.teacherB,
        lessons.substituted,
        "Unit 4",
        "Workbook p. 34",
        null,
      );
      expect(created).toMatchObject({
        status: "saved",
        log: {
          content: "Unit 4",
          homework: "Workbook p. 34",
          updatedByName: "Bob",
        },
      });
      if (created.status !== "saved" || !created.log)
        throw new Error("not saved");

      // A loaded the empty form earlier: their save is refused, not merged.
      expect(
        await log(ids.teacherA, lessons.substituted, "Mine", null, null),
      ).toEqual({
        status: "conflict",
        by: "Bob",
      });

      // With the current version, the regular teacher can edit it too.
      const updated = await log(
        ids.teacherA,
        lessons.substituted,
        "Unit 4 and 5",
        "Workbook p. 34",
        created.log.updatedAt,
      );
      expect(updated).toMatchObject({
        status: "saved",
        log: { updatedByName: "Anna" },
      });
      const row = await db.lessonLog.findFirstOrThrow({
        where: { lessonId: lessons.substituted },
      });
      expect(row).toMatchObject({
        authorId: ids.teacherB,
        updatedById: ids.teacherA,
        content: "Unit 4 and 5",
      });

      // B's stale version is refused.
      expect(
        await log(
          ids.teacherB,
          lessons.substituted,
          null,
          null,
          created.log.updatedAt,
        ),
      ).toEqual({
        status: "conflict",
        by: "Anna",
      });

      // The badge clears, the next lesson shows the homework as a reminder.
      expect((await load(ids.teacherA, lessons.substituted))?.badge).toBeNull();
      expect(
        (await load(ids.teacherA, lessons.upcoming))?.previousHomework,
      ).toEqual({
        homework: "Workbook p. 34",
        date: "2026-10-15",
      });

      // Both fields empty removes the record.
      if (updated.status !== "saved" || !updated.log)
        throw new Error("not saved");
      expect(
        await log(
          ids.teacherA,
          lessons.substituted,
          null,
          null,
          updated.log.updatedAt,
        ),
      ).toEqual({
        status: "saved",
        log: null,
      });
      expect(
        await db.lessonLog.count({ where: { lessonId: lessons.substituted } }),
      ).toBe(0);
      // Saving an empty form with no record changes nothing.
      expect(
        await log(ids.teacherA, lessons.substituted, null, null, null),
      ).toEqual({
        status: "saved",
        log: null,
      });
    });

    it("keeps homework without a log; it still counts as No log yet", async () => {
      const saved = await log(ids.teacherA, lessons.first, null, "Essay", null);
      expect(saved).toMatchObject({
        status: "saved",
        log: { content: null, homework: "Essay" },
      });
      expect((await load(ids.teacherA, lessons.first))?.badge).toBe("noLog");
    });

    it("refuses before the start, on cancelled lessons and on other lessons", async () => {
      expect(
        await errorKey(log(ids.teacherA, lessons.upcoming, "x", null, null)),
      ).toBe("lessonLog.locked.notStarted");
      expect(
        await errorKey(log(ids.teacherA, lessons.cancelled, "x", null, null)),
      ).toBe("lessonLog.locked.cancelled");
      for (const [teacher, lesson] of [
        [ids.teacherB, lessons.first],
        [ids.teacherC, lessons.first],
        [ids.teacherA, lessons.foreign],
      ]) {
        expect(await errorKey(log(teacher, lesson, "x", null, null))).toBe(
          "common.error.notFound",
        );
      }
      expect(
        await db.lessonLog.count({
          where: { lessonId: { in: [lessons.upcoming, lessons.cancelled] } },
        }),
      ).toBe(0);
      expect(
        await client.lessonLog.count({ where: { lessonId: lessons.foreign } }),
      ).toBe(0);
    });

    it("rejects an empty log at the database level", async () => {
      await expect(
        client.lessonLog.create({
          data: {
            schoolId,
            lessonId: lessons.upcoming,
            authorId: ids.teacherA,
            updatedById: ids.teacherA,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("lesson list and To do", () => {
    it("filters the teacher's lessons of the current term", async () => {
      const list = (
        filter: "noLog" | "upcoming" | "past",
        teacher = ids.teacherA,
      ) => listTeacherLessons(db, teacher, { filter }, NOW, TZ);
      const noLog = await list("noLog");
      expect(noLog.termId).toBe(ids.term);
      expect(noLog.items.map((i) => i.id)).toEqual([
        lessons.first,
        lessons.substituted,
      ]);
      expect(noLog.noLogCount).toBe(2);
      expect((await list("upcoming")).items.map((i) => i.id)).toEqual([
        lessons.upcoming,
      ]);
      expect((await list("past")).items.map((i) => i.id)).toEqual([
        lessons.cancelled,
        lessons.substituted,
        lessons.first,
      ]);
      expect((await list("past", ids.teacherB)).items.map((i) => i.id)).toEqual(
        [lessons.substituted],
      );
      expect(noLog.groups).toEqual([{ id: ids.group, name: "B1 Evening" }]);
    });

    it("lists up to 5 recent lessons without a log, oldest first", async () => {
      const todo = await loadTeacherTodo(db, ids.teacherA, NOW, TZ);
      expect(todo.map((i) => i.id)).toEqual([
        lessons.first,
        lessons.substituted,
      ]);
      expect(
        await loadTeacherTodo(
          db,
          ids.teacherC,
          new Date("2026-11-30T00:00:00Z"),
          TZ,
        ),
      ).toEqual([]);
    });
  });

  describe("internal notes", () => {
    const teacher = (teacherId: string) => ({
      role: "TEACHER" as const,
      teacherId,
    });
    const add = (
      teacherId: string,
      lessonId: string,
      about: string,
      body: string,
    ) =>
      createLessonNote(
        db,
        schoolId,
        teacher(teacherId),
        { lessonId, about, body },
        NOW,
      );

    it("adds, edits and deletes own notes; others' are read-only", async () => {
      const onLesson = await add(
        ids.teacherA,
        lessons.first,
        "lesson",
        "Ran out of time",
      );
      const aboutGroup = await add(
        ids.teacherA,
        lessons.first,
        "group",
        "Ready for tests",
      );
      const aboutStudent = await add(
        ids.teacherA,
        lessons.first,
        `student:${ids.current}`,
        "Needs extra time",
      );
      expect(aboutGroup.about).toEqual({ kind: "group", name: "B1 Evening" });
      expect(aboutStudent.about).toEqual({ kind: "student", name: "Cara" });
      const stored = await db.teacherNote.findFirstOrThrow({
        where: { id: aboutStudent.id },
      });
      expect(stored).toMatchObject({
        lessonId: lessons.first,
        studentId: ids.current,
        groupId: null,
      });

      // Only current members of the group can be the subject.
      expect(
        await errorKey(
          add(ids.teacherA, lessons.first, `student:${ids.leaver}`, "x"),
        ),
      ).toBe("validation.select");

      // A note on C's lesson about C's group: not "earlier" for this group.
      await add(ids.teacherC, lessons.otherGroup, "group", "Other group note");

      const notes = await loadLessonNotes(
        db,
        teacher(ids.teacherA),
        lessons.first,
        NOW,
      );
      expect(notes.onLesson.map((n) => n.body).sort()).toEqual([
        "Needs extra time",
        "Ran out of time",
        "Ready for tests",
      ]);
      const created = notes.onLesson.map((n) => n.createdAt);
      expect(created).toEqual([...created].sort().reverse());
      expect(notes.onLesson.every((n) => n.own)).toBe(true);
      expect(notes.earlierCount).toBe(0);

      // The substitute sees them as earlier notes, read-only.
      const forSub = await loadLessonNotes(
        db,
        teacher(ids.teacherB),
        lessons.substituted,
        NOW,
      );
      expect(forSub.onLesson).toEqual([]);
      expect(forSub.earlierCount).toBe(3);
      expect(forSub.earlier.map((n) => n.body).sort()).toEqual([
        "Needs extra time",
        "Ran out of time",
        "Ready for tests",
      ]);
      expect(forSub.earlier.some((n) => n.own)).toBe(false);
      expect(forSub.earlier[0].lessonStartsAt).toBe(
        at("2026-10-13T15:00:00Z").toISOString(),
      );
      expect(
        await loadEarlierNotes(
          db,
          teacher(ids.teacherB),
          lessons.substituted,
          2,
          NOW,
        ),
      ).toHaveLength(1);

      // Only the author edits or deletes.
      expect(
        await errorKey(
          updateLessonNote(db, teacher(ids.teacherB), {
            noteId: onLesson.id,
            body: "x",
          }),
        ),
      ).toBe("common.error.notFound");
      expect(
        await errorKey(
          deleteLessonNote(db, teacher(ids.teacherB), onLesson.id),
        ),
      ).toBe("common.error.notFound");
      const later = new Date(Date.now() + 5_000);
      await client.teacherNote.update({
        where: { id: onLesson.id },
        data: { updatedAt: later, body: "Ran out of time!" },
      });
      const reloaded = await loadLessonNotes(
        db,
        teacher(ids.teacherA),
        lessons.first,
        NOW,
      );
      expect(reloaded.onLesson.find((n) => n.id === onLesson.id)?.edited).toBe(
        true,
      );
      const edited = await updateLessonNote(db, teacher(ids.teacherA), {
        noteId: onLesson.id,
        body: "Repeat reading",
      });
      expect(edited.body).toBe("Repeat reading");
      await deleteLessonNote(db, teacher(ids.teacherA), onLesson.id);
      expect(await db.teacherNote.count({ where: { id: onLesson.id } })).toBe(
        0,
      );
    });

    it("admins read every lesson's notes; nobody else gets in", async () => {
      const admin = await loadLessonNotes(
        db,
        { role: "ADMIN" },
        lessons.first,
        NOW,
      );
      expect(admin.onLesson.length).toBeGreaterThan(0);
      expect(admin.onLesson.some((n) => n.own)).toBe(false);

      await expect(
        loadLessonNotes(
          db,
          { role: "STUDENT", teacherId: null },
          lessons.first,
          NOW,
        ),
      ).rejects.toBeInstanceOf(TeacherNoteAccessError);
      expect(
        await errorKey(
          loadLessonNotes(db, teacher(ids.teacherC), lessons.first, NOW),
        ),
      ).toBe("common.error.notFound");
      expect(
        await errorKey(add(ids.teacherC, lessons.first, "lesson", "sneaky")),
      ).toBe("common.error.notFound");
      // Another school's lesson doesn't exist here, not even for its admin.
      expect(
        await errorKey(
          loadLessonNotes(otherDb, { role: "ADMIN" }, lessons.first, NOW),
        ),
      ).toBe("common.error.notFound");
      expect(
        await errorKey(
          loadLessonNotes(db, { role: "ADMIN" }, lessons.foreign, NOW),
        ),
      ).toBe("common.error.notFound");
    });

    it("keeps notes on future and cancelled lessons", async () => {
      await add(ids.teacherA, lessons.upcoming, "lesson", "Bring the CD");
      await add(ids.teacherA, lessons.cancelled, "lesson", "Move the test");
      expect(
        (
          await loadLessonNotes(
            db,
            teacher(ids.teacherA),
            lessons.upcoming,
            NOW,
          )
        ).onLesson,
      ).toHaveLength(1);
      expect(
        (
          await loadLessonNotes(
            db,
            teacher(ids.teacherA),
            lessons.cancelled,
            NOW,
          )
        ).onLesson,
      ).toHaveLength(1);
    });
  });
});
