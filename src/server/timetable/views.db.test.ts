// Authorization of the read-only weekly timetable against a real Postgres.
// Opt-in, like the other DB tests: set SCHEDULING_TEST_DATABASE_URL to a
// migrated database (never your dev database; the test creates and deletes
// its own schools).

import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { scopeToSchool } from "@/server/db/school-scope";
import { fromIsoDate, zonedTimeToUtc } from "@/server/scheduling";

import type { SchoolDb } from "./service";
import { loadWeek } from "./views";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
const TZ = "Europe/Bratislava";
const WEEK = "2026-10-19"; // Monday

describe.skipIf(!url)("weekly timetable views (database)", () => {
  let client: PrismaClient;
  let db: SchoolDb;
  let otherDb: SchoolDb;
  const schools: string[] = [];
  const users = {
    admin: "",
    teacherA: "",
    teacherB: "",
    student: "",
    newcomer: "",
    loner: "",
  };
  const ids = {
    publishedTerm: randomUUID(),
    draftTerm: randomUUID(),
    teacherA: randomUUID(),
    teacherB: randomUUID(),
    student: randomUUID(),
    newcomer: randomUUID(),
    loner: randomUUID(),
    groupA: randomUUID(),
    groupB: randomUUID(),
    room: randomUUID(),
  };
  const lessonIds = {
    aMonday: randomUUID(),
    aWednesday: randomUUID(),
    bTuesday: randomUUID(),
    bSubstitutedByA: randomUUID(),
    draft: randomUUID(),
  };

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    const suffix = randomUUID().slice(0, 8);
    const school = await client.school.create({
      data: {
        name: `Views test ${suffix}`,
        slug: `views-test-${suffix}`,
        timezone: TZ,
      },
    });
    const other = await client.school.create({
      data: {
        name: `Other ${suffix}`,
        slug: `views-other-${suffix}`,
        timezone: TZ,
      },
    });
    schools.push(school.id, other.id);
    const schoolId = school.id;
    db = scopeToSchool(client, schoolId);
    otherDb = scopeToSchool(client, other.id);

    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      const user = await client.user.create({
        data: {
          name: key,
          email: `${key.toLowerCase()}-${suffix}@example.test`,
        },
      });
      users[key] = user.id;
    }
    await client.membership.createMany({
      data: [
        { schoolId, userId: users.admin, role: "ADMIN" },
        { schoolId, userId: users.teacherA, role: "TEACHER" },
        { schoolId, userId: users.teacherB, role: "TEACHER" },
        { schoolId, userId: users.student, role: "STUDENT" },
        { schoolId, userId: users.newcomer, role: "STUDENT" },
        { schoolId, userId: users.loner, role: "STUDENT" },
      ],
    });
    await client.teacherProfile.createMany({
      data: [
        { id: ids.teacherA, schoolId, userId: users.teacherA },
        { id: ids.teacherB, schoolId, userId: users.teacherB },
      ],
    });
    await client.studentProfile.createMany({
      data: [
        { id: ids.student, schoolId, userId: users.student },
        { id: ids.newcomer, schoolId, userId: users.newcomer },
        { id: ids.loner, schoolId, userId: users.loner },
      ],
    });
    const level = await client.level.create({
      data: { schoolId, code: "B1", name: "B1", rank: 1 },
    });
    await client.group.createMany({
      data: [
        {
          id: ids.groupA,
          schoolId,
          levelId: level.id,
          type: "GROUP",
          name: "GA",
          capacity: 8,
        },
        {
          id: ids.groupB,
          schoolId,
          levelId: level.id,
          type: "GROUP",
          name: "GB",
          capacity: 8,
        },
      ],
    });
    await client.groupMembership.createMany({
      data: [
        {
          schoolId,
          groupId: ids.groupA,
          studentId: ids.student,
          joinedAt: new Date("2026-09-01T00:00:00Z"),
        },
        // Joins GA on Tuesday: sees Wednesday's lesson, not Monday's.
        {
          schoolId,
          groupId: ids.groupA,
          studentId: ids.newcomer,
          joinedAt: new Date("2026-10-20T00:00:00Z"),
        },
      ],
    });
    await client.room.create({
      data: {
        id: ids.room,
        schoolId,
        name: "Room",
        kind: "PHYSICAL",
        capacity: 8,
      },
    });
    await client.term.createMany({
      data: [
        {
          id: ids.publishedTerm,
          schoolId,
          name: "Published",
          startDate: fromIsoDate("2026-09-14"),
          endDate: fromIsoDate("2026-12-20"),
          timetablePublishedAt: new Date("2026-09-01T00:00:00Z"),
        },
        {
          id: ids.draftTerm,
          schoolId,
          name: "Draft",
          startDate: fromIsoDate("2026-10-19"),
          endDate: fromIsoDate("2026-10-25"),
        },
      ],
    });
    const at = (date: string, minute: number) =>
      zonedTimeToUtc(date, minute, TZ);
    const lesson = (
      id: string,
      termId: string,
      groupId: string,
      teacherId: string,
      date: string,
      extra: { substituteTeacherId?: string } = {},
    ) => ({
      id,
      schoolId,
      termId,
      groupId,
      teacherId,
      roomId: ids.room,
      startsAt: at(date, 17 * 60),
      endsAt: at(date, 18 * 60),
      ...extra,
    });
    await client.lesson.createMany({
      data: [
        lesson(
          lessonIds.aMonday,
          ids.publishedTerm,
          ids.groupA,
          ids.teacherA,
          "2026-10-19",
        ),
        lesson(
          lessonIds.aWednesday,
          ids.publishedTerm,
          ids.groupA,
          ids.teacherA,
          "2026-10-21",
        ),
        lesson(
          lessonIds.bTuesday,
          ids.publishedTerm,
          ids.groupB,
          ids.teacherB,
          "2026-10-20",
        ),
        lesson(
          lessonIds.bSubstitutedByA,
          ids.publishedTerm,
          ids.groupB,
          ids.teacherB,
          "2026-10-22",
          {
            substituteTeacherId: ids.teacherA,
          },
        ),
        // A lesson in a draft term (should not exist in practice, but must
        // stay invisible to teachers and students if it does).
        lesson(
          lessonIds.draft,
          ids.draftTerm,
          ids.groupA,
          ids.teacherA,
          "2026-10-23",
        ),
      ],
    });
  });

  afterAll(async () => {
    if (!client) return;
    await client.lesson.deleteMany({ where: { schoolId: { in: schools } } });
    await client.school.deleteMany({ where: { id: { in: schools } } });
    await client.user.deleteMany({
      where: { id: { in: Object.values(users).filter(Boolean) } },
    });
    await client.$disconnect();
  });

  const lessonsFor = async (
    kind: "ADMIN" | "TEACHER" | "STUDENT",
    userId: string,
  ) =>
    (await loadWeek(db, { kind, userId }, WEEK)).lessons
      .map((l) => l.id)
      .sort();

  it("shows the admin every lesson of the school", async () => {
    expect(await lessonsFor("ADMIN", users.admin)).toEqual(
      Object.values(lessonIds).sort(),
    );
  });

  it("filters the admin view by teacher (including substitutions)", async () => {
    const week = await loadWeek(
      db,
      { kind: "ADMIN", userId: users.admin },
      WEEK,
      {
        teacherId: ids.teacherB,
      },
    );
    expect(week.lessons.map((l) => l.id).sort()).toEqual(
      [lessonIds.bTuesday, lessonIds.bSubstitutedByA].sort(),
    );
  });

  it("shows a teacher only lessons they teach or substitute, published only", async () => {
    expect(await lessonsFor("TEACHER", users.teacherA)).toEqual(
      [
        lessonIds.aMonday,
        lessonIds.aWednesday,
        lessonIds.bSubstitutedByA,
      ].sort(),
    );
    const week = await loadWeek(
      db,
      { kind: "TEACHER", userId: users.teacherB },
      WEEK,
    );
    expect(week.lessons.map((l) => [l.id, l.teacherRole]).sort()).toEqual(
      [
        [lessonIds.bTuesday, "regular"],
        [lessonIds.bSubstitutedByA, "covered"],
      ].sort(),
    );
  });

  it("shows a student only their groups' lessons, without classmates", async () => {
    const week = await loadWeek(
      db,
      { kind: "STUDENT", userId: users.student },
      WEEK,
    );
    expect(week.lessons.map((l) => l.id).sort()).toEqual(
      [lessonIds.aMonday, lessonIds.aWednesday].sort(),
    );
    expect(week.lessons.every((l) => l.students === null)).toBe(true);
  });

  it("shows a student only lessons after they joined", async () => {
    expect(await lessonsFor("STUDENT", users.newcomer)).toEqual([
      lessonIds.aWednesday,
    ]);
  });

  it("tells a student in no group so", async () => {
    const week = await loadWeek(
      db,
      { kind: "STUDENT", userId: users.loner },
      WEEK,
    );
    expect(week.lessons).toEqual([]);
    expect(week.state).toBe("noGroups");
  });

  it("hides draft terms from teachers and students", async () => {
    const week = await loadWeek(
      db,
      { kind: "TEACHER", userId: users.teacherA },
      "2026-12-21",
    );
    expect(week.state).toBe("noTerm");
    await client.term.update({
      where: { id: ids.publishedTerm },
      data: { timetablePublishedAt: null },
    });
    try {
      const hidden = await loadWeek(
        db,
        { kind: "TEACHER", userId: users.teacherA },
        WEEK,
      );
      expect(hidden.lessons).toEqual([]);
      expect(hidden.state).toBe("notPublished");
      expect(await lessonsFor("STUDENT", users.student)).toEqual([]);
    } finally {
      await client.term.update({
        where: { id: ids.publishedTerm },
        data: { timetablePublishedAt: new Date("2026-09-01T00:00:00Z") },
      });
    }
  });

  it("never leaks lessons across schools", async () => {
    // The same user id asking through another school's client sees nothing.
    const week = await loadWeek(
      otherDb,
      { kind: "ADMIN", userId: users.admin },
      WEEK,
    );
    expect(week.lessons).toEqual([]);
    const teacher = await loadWeek(
      otherDb,
      { kind: "TEACHER", userId: users.teacherA },
      WEEK,
    );
    expect(teacher.lessons).toEqual([]);
  });
});
