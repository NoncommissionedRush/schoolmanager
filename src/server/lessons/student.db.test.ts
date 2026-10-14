// Student and admin read views against a real Postgres (lessons.md §2, §6,
// §7). Opt-in, like the other DB tests: set SCHEDULING_TEST_DATABASE_URL to
// a migrated database (never your dev database; the test creates and
// deletes its own schools).

import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { scopeToSchool } from "@/server/db/school-scope";
import { loadStudentNotes } from "@/server/notes/teacher-notes";
import type { SchoolDb } from "@/server/timetable/service";

import { listAdminLessons, loadAdminLesson } from "./admin";
import {
  listStudentHomework,
  loadLatestHomework,
  loadStudentLesson,
  loadStudentScope,
  STUDENT_LESSON_KEYS,
  type StudentScope,
} from "./student";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
const TZ = "Europe/Bratislava";
const NOW = new Date("2026-10-20T12:00:00Z");
const at = (iso: string) => new Date(iso);
const SECRET = "Needs extra time in written tasks";

describe.skipIf(!url)("student & admin lesson views (database)", () => {
  let client: PrismaClient;
  let db: SchoolDb;
  let otherDb: SchoolDb;
  const schools: string[] = [];
  const users: string[] = [];
  const userIds: Record<string, string> = {};
  const ids = {
    teacherA: randomUUID(),
    teacherB: randomUUID(),
    cara: randomUUID(), // in `group` since June
    leaver: randomUUID(), // left `group` on 16 Oct
    newbie: randomUUID(), // joined `group` on 16 Oct
    outsider: randomUUID(), // only in `otherGroup`
    loner: randomUUID(), // in no group
    group: randomUUID(),
    otherGroup: randomUUID(),
    term: randomUUID(),
    draftTerm: randomUUID(),
  };
  const lessons = {
    first: randomUUID(), // Mon 13 Oct: log + homework, internal note
    substituted: randomUUID(), // Wed 15 Oct: B substitutes, log + homework
    cancelled: randomUUID(), // Mon 20 Oct 10:00, cancelled, started
    upcoming: randomUUID(), // Wed 22 Oct, future (log inserted anyway)
    otherGroup: randomUUID(), // Tue 14 Oct, other group
    draft: randomUUID(), // 10 Aug, unpublished term
    foreign: randomUUID(), // other school
  };

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    const suffix = randomUUID().slice(0, 8);
    const school = await client.school.create({
      data: { name: `Hw ${suffix}`, slug: `hw-${suffix}`, timezone: TZ },
    });
    const other = await client.school.create({
      data: { name: `Hw O ${suffix}`, slug: `hw-o-${suffix}`, timezone: TZ },
    });
    schools.push(school.id, other.id);
    const schoolId = school.id;
    db = scopeToSchool(client, schoolId);
    otherDb = scopeToSchool(client, other.id);

    const person = async (
      name: string,
      role: "TEACHER" | "STUDENT",
      inSchool = schoolId,
    ) => {
      const user = await client.user.create({
        data: { name, email: `${name.toLowerCase()}-${suffix}@example.test` },
      });
      users.push(user.id);
      userIds[name] = user.id;
      await client.membership.create({
        data: { schoolId: inSchool, userId: user.id, role },
      });
      return user.id;
    };
    await client.teacherProfile.createMany({
      data: [
        { id: ids.teacherA, schoolId, userId: await person("Anna", "TEACHER") },
        { id: ids.teacherB, schoolId, userId: await person("Bob", "TEACHER") },
      ],
    });
    await client.studentProfile.createMany({
      data: [
        { id: ids.cara, schoolId, userId: await person("Cara", "STUDENT") },
        { id: ids.leaver, schoolId, userId: await person("Leo", "STUDENT") },
        { id: ids.newbie, schoolId, userId: await person("Nina", "STUDENT") },
        { id: ids.outsider, schoolId, userId: await person("Otto", "STUDENT") },
        { id: ids.loner, schoolId, userId: await person("Lone", "STUDENT") },
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
          name: "A2 Late",
          capacity: 8,
        },
      ],
    });
    const member = (
      studentId: string,
      groupId: string,
      joinedAt: string,
      leftAt?: string,
    ) => ({
      schoolId,
      groupId,
      studentId,
      joinedAt: at(joinedAt),
      leftAt: leftAt ? at(leftAt) : null,
    });
    await client.groupMembership.createMany({
      data: [
        member(ids.cara, ids.group, "2026-06-01T00:00:00Z"),
        member(
          ids.leaver,
          ids.group,
          "2026-09-01T00:00:00Z",
          "2026-10-16T00:00:00Z",
        ),
        member(ids.newbie, ids.group, "2026-10-16T00:00:00Z"),
        member(ids.outsider, ids.otherGroup, "2026-09-01T00:00:00Z"),
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
          name: "Summer school",
          startDate: at("2026-08-03T00:00:00Z"),
          endDate: at("2026-08-28T00:00:00Z"),
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
          { substituteTeacherId: ids.teacherB },
        ),
        lesson(
          lessons.cancelled,
          "2026-10-20T08:00:00Z",
          "2026-10-20T09:30:00Z",
          { status: "CANCELLED", cancelReason: "HOLIDAY" },
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
          { groupId: ids.otherGroup, teacherId: ids.teacherB },
        ),
        lesson(lessons.draft, "2026-08-10T15:00:00Z", "2026-08-10T16:30:00Z", {
          termId: ids.draftTerm,
        }),
      ],
    });
    const logOf = (
      lessonId: string,
      content: string | null,
      homework: string | null,
      by = ids.teacherA,
    ) => ({
      schoolId,
      lessonId,
      authorId: by,
      updatedById: by,
      content,
      homework,
    });
    await client.lessonLog.createMany({
      data: [
        logOf(lessons.first, "Unit 4: present perfect", "One page essay"),
        logOf(
          lessons.substituted,
          "Reading: unit 5",
          "Workbook p. 34",
          ids.teacherB,
        ),
        logOf(lessons.upcoming, null, "FUTURE homework"),
        logOf(
          lessons.otherGroup,
          "Listening",
          "Podcast episode 3",
          ids.teacherB,
        ),
        logOf(lessons.draft, "Summer topic", "Summer homework"),
      ],
    });
    await client.teacherNote.createMany({
      data: [
        {
          schoolId,
          authorId: ids.teacherA,
          lessonId: lessons.first,
          studentId: ids.cara,
          body: SECRET,
        },
        {
          schoolId,
          authorId: ids.teacherA,
          lessonId: lessons.first,
          groupId: ids.group,
          body: "Group note",
        },
      ],
    });

    // The other school: one lesson, for cross-school ids.
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
    const foreignGroup = await client.group.create({
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
        groupId: foreignGroup.id,
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

  const scopeOf = (name: string) => loadStudentScope(db, userIds[name]);
  const visibleTo = async (scope: StudentScope) => {
    const visible: string[] = [];
    for (const [key, id] of Object.entries(lessons)) {
      if (await loadStudentLesson(db, scope, id, NOW, TZ)) visible.push(key);
    }
    return visible.sort();
  };

  describe("which lessons a student can open", () => {
    it("started lessons of their group in published terms, cancelled too", async () => {
      expect(await visibleTo(await scopeOf("Cara"))).toEqual(
        ["cancelled", "first", "substituted"].sort(),
      );
    });

    it("only lessons while they were a member", async () => {
      // Left on 16 Oct: keeps the earlier lessons, gets no new ones.
      expect(await visibleTo(await scopeOf("Leo"))).toEqual([
        "first",
        "substituted",
      ]);
      // Joined on 16 Oct: from the join date onwards.
      expect(await visibleTo(await scopeOf("Nina"))).toEqual(["cancelled"]);
      expect(await visibleTo(await scopeOf("Otto"))).toEqual(["otherGroup"]);
      expect(await visibleTo(await scopeOf("Lone"))).toEqual([]);
    });

    it("never opens another school's lesson or a malformed id", async () => {
      const cara = await scopeOf("Cara");
      expect(
        await loadStudentLesson(otherDb, cara, lessons.first, NOW, TZ),
      ).toBeNull();
      expect(await loadStudentLesson(db, cara, "nonsense", NOW, TZ)).toBeNull();
    });

    it("returns the student-safe DTO, without internal notes", async () => {
      const view = await loadStudentLesson(
        db,
        await scopeOf("Cara"),
        lessons.substituted,
        NOW,
        TZ,
      );
      expect(Object.keys(view!).sort()).toEqual(
        [...STUDENT_LESSON_KEYS].sort(),
      );
      expect(view).toMatchObject({
        date: "2026-10-15",
        startMinute: 17 * 60,
        teacherName: "Anna",
        substituteName: "Bob",
        content: "Reading: unit 5",
        homework: "Workbook p. 34",
      });
      const first = await loadStudentLesson(
        db,
        await scopeOf("Cara"),
        lessons.first,
        NOW,
        TZ,
      );
      expect(JSON.stringify(first)).not.toContain(SECRET);
      expect(JSON.stringify(first)).not.toContain("Group note");
    });
  });

  describe("Homework tab", () => {
    it("lists started lessons newest first, cancelled ones included", async () => {
      const list = await listStudentHomework(
        db,
        await scopeOf("Cara"),
        { shown: 20 },
        NOW,
        TZ,
      );
      expect(list.items.map((i) => i.id)).toEqual([
        lessons.cancelled,
        lessons.substituted,
        lessons.first,
      ]);
      expect(list.items[0].status).toBe("CANCELLED");
      expect(list.hasMore).toBe(false);
      expect(list.groups.map((g) => g.name)).toEqual(["B1 Evening"]);
      expect(JSON.stringify(list)).not.toContain("FUTURE");
      expect(JSON.stringify(list)).not.toContain("Summer homework");
      expect(JSON.stringify(list)).not.toContain(SECRET);
    });

    it("pages with Load more", async () => {
      const list = await listStudentHomework(
        db,
        await scopeOf("Cara"),
        { shown: 2 },
        NOW,
        TZ,
      );
      expect(list.items).toHaveLength(2);
      expect(list.hasMore).toBe(true);
    });

    it("keeps the history of groups the student left", async () => {
      const list = await listStudentHomework(
        db,
        await scopeOf("Leo"),
        { shown: 20 },
        NOW,
        TZ,
      );
      expect(list.items.map((i) => i.id)).toEqual([
        lessons.substituted,
        lessons.first,
      ]);
      expect(list.groups.map((g) => g.id)).toEqual([ids.group]);
    });

    it("filters by one of the student's groups, ignoring others", async () => {
      const cara = await scopeOf("Cara");
      const filtered = await listStudentHomework(
        db,
        cara,
        { groupId: ids.group, shown: 20 },
        NOW,
        TZ,
      );
      expect(filtered.groupId).toBe(ids.group);
      expect(filtered.items).toHaveLength(3);
      // Someone else's group isn't a valid filter: it's ignored.
      const foreign = await listStudentHomework(
        db,
        cara,
        { groupId: ids.otherGroup, shown: 20 },
        NOW,
        TZ,
      );
      expect(foreign.groupId).toBeNull();
      expect(foreign.items.map((i) => i.group.id)).not.toContain(
        ids.otherGroup,
      );
    });

    it("is empty for a student in no group", async () => {
      const list = await listStudentHomework(
        db,
        await scopeOf("Lone"),
        { shown: 20 },
        NOW,
        TZ,
      );
      expect(list).toEqual({
        items: [],
        hasMore: false,
        groups: [],
        groupId: null,
      });
    });
  });

  describe("Latest homework card", () => {
    it("shows the last lesson's homework of each current group", async () => {
      expect(
        await loadLatestHomework(db, await scopeOf("Cara"), NOW, TZ),
      ).toEqual([
        {
          group: { id: ids.group, name: "B1 Evening" },
          date: "2026-10-15",
          homework: "Workbook p. 34",
          lessonId: lessons.substituted,
        },
      ]);
    });

    it("shows a new student the group's latest homework, without the link", async () => {
      const [item] = await loadLatestHomework(
        db,
        await scopeOf("Nina"),
        NOW,
        TZ,
      );
      expect(item).toMatchObject({
        homework: "Workbook p. 34",
        lessonId: null,
      });
    });

    it("leaves out groups the student left", async () => {
      expect(
        await loadLatestHomework(db, await scopeOf("Leo"), NOW, TZ),
      ).toEqual([]);
    });
  });

  describe("admin read-only views", () => {
    it("opens any lesson of the school, unpublished terms included", async () => {
      const page = await loadAdminLesson(db, lessons.first, NOW, TZ);
      expect(page).toMatchObject({
        id: lessons.first,
        log: { content: "Unit 4: present perfect", homework: "One page essay" },
        nextLessonId: lessons.substituted,
      });
      expect(page).not.toHaveProperty("ids");
      expect(await loadAdminLesson(db, lessons.draft, NOW, TZ)).not.toBeNull();
      expect(await loadAdminLesson(db, lessons.foreign, NOW, TZ)).toBeNull();
      expect(await loadAdminLesson(db, "nonsense", NOW, TZ)).toBeNull();
    });

    it("lists lessons without a log across the school, by teacher", async () => {
      const all = await listAdminLessons(
        db,
        { filter: "past", termId: ids.term },
        NOW,
        TZ,
      );
      expect(all.items.map((i) => i.id)).toEqual([
        lessons.cancelled,
        lessons.substituted,
        lessons.otherGroup,
        lessons.first,
      ]);
      expect(all.teachers.map((t) => t.name)).toEqual(["Anna", "Bob"]);
      const sub = all.items.find((i) => i.id === lessons.substituted);
      expect(sub).toMatchObject({ teacherName: "Anna", substituteName: "Bob" });

      // Bob teaches the other group and substitutes on 15 Oct.
      const bob = await listAdminLessons(
        db,
        { filter: "past", termId: ids.term, teacherId: ids.teacherB },
        NOW,
        TZ,
      );
      expect(bob.items.map((i) => i.id).sort()).toEqual(
        [lessons.otherGroup, lessons.substituted].sort(),
      );

      const noLog = await listAdminLessons(
        db,
        { filter: "noLog", termId: ids.term },
        NOW,
        TZ,
      );
      // Every ended lesson here has a log; the cancelled one doesn't count.
      expect(noLog.items).toEqual([]);
      expect(noLog.noLogCount).toBe(0);
    });

    it("reads all internal notes about a student", async () => {
      const notes = await loadStudentNotes(db, { role: "ADMIN" }, ids.cara);
      expect(notes.map((n) => n.body)).toEqual([SECRET]);
      expect(notes[0]).toMatchObject({
        author: { name: "Anna" },
        about: { kind: "student", name: "Cara" },
        own: false,
      });
      expect(
        await loadStudentNotes(otherDb, { role: "ADMIN" }, ids.cara),
      ).toEqual([]);
    });
  });
});
