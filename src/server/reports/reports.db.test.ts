// Reports against a real Postgres (docs/architecture/phase6-rules.md §9).
// Opt-in, like the other DB tests: set SCHEDULING_TEST_DATABASE_URL to a
// migrated database (never your dev database; the test creates and deletes
// its own schools).

import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { scopeToSchool } from "@/server/db/school-scope";
import { addDays, zonedTimeToUtc } from "@/server/scheduling";
import type { SchoolDb } from "@/server/timetable/service";

import { exportReportData, loadReportData } from "./admin-data";
import { ReportError } from "./rules";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
const TZ = "Europe/Bratislava";
const local = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return zonedTimeToUtc(date, h * 60 + m, TZ);
};
// Fri 20 Nov 2026, 12:00.
const NOW = local("2026-11-20", "12:00");

describe.skipIf(!url)("reports (database)", () => {
  // Unique per file: the cleanup deletes only this file's users.
  const suffix = randomUUID().slice(0, 8);
  let client: PrismaClient;
  let db: SchoolDb;
  let otherDb: SchoolDb;
  let bigDb: SchoolDb;
  let emptyDb: SchoolDb;
  let schoolId: string;
  let otherId: string;
  let adminId: string;
  const schools: string[] = [];
  const id = () => randomUUID();
  const ids = {
    tomas: id(),
    ana: id(),
    eva: id(),
    sara: id(),
    pavol: id(),
    rita: id(),
    otto: id(),
    g1: id(),
    g2: id(),
    o1: id(),
    room: id(),
    term: id(),
    draft: id(),
    foreignTeacher: id(),
    foreignStudent: id(),
    foreignGroup: id(),
    foreignTerm: id(),
  };
  const lessons = {
    l1: id(), // Mon 2 Nov, g1, Tomas
    l2: id(), // Mon 9 Nov, g1 (Pavol absent, credit)
    l3: id(), // Mon 16 Nov, g1 (Rita's replacement)
    l4: id(), // Mon 23 Nov, future
    l5: id(), // Tue 10 Nov, holiday
    l6: id(), // Thu 12 Nov, g1, Ana substitutes
    g2a: id(), // Tue 3 Nov, g2, Eva (Rita absent, credit)
    o1a: id(), // Wed 4 Nov, 1-on-1, Otto cancelled in time
    o1m: id(), // Fri 6 Nov, the makeup of o1a
    o1b: id(), // Wed 11 Nov, 1-on-1
    draftLesson: id(), // unpublished term (dated in the custom period)
    foreign: id(),
  };

  const person = async (
    name: string,
    role: "ADMIN" | "TEACHER" | "STUDENT",
    inSchool: string,
  ) => {
    const row = await client.user.create({
      data: {
        name,
        email: `${name.toLowerCase().replace(/\W/g, "")}-${randomUUID().slice(0, 6)}-${suffix}@example.test`,
      },
    });
    await client.membership.create({
      data: { schoolId: inSchool, userId: row.id, role },
    });
    return row.id;
  };
  const school = async (slug: string) => {
    const row = await client.school.create({
      data: {
        name: `Rep ${slug} ${suffix}`,
        slug: `rep-${slug}-${suffix}`,
        timezone: TZ,
      },
    });
    schools.push(row.id);
    return row.id;
  };

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    schoolId = await school("a");
    otherId = await school("b");
    const bigId = await school("big");
    const emptyId = await school("empty");
    db = scopeToSchool(client, schoolId);
    otherDb = scopeToSchool(client, otherId);
    bigDb = scopeToSchool(client, bigId);
    emptyDb = scopeToSchool(client, emptyId);

    adminId = await person("Admin", "ADMIN", schoolId);
    for (const [name, pid] of [
      ["Tomas", ids.tomas],
      ["Ana", ids.ana],
      ["Eva", ids.eva],
    ] as const) {
      await client.teacherProfile.create({
        data: {
          id: pid,
          schoolId,
          userId: await person(name, "TEACHER", schoolId),
        },
      });
    }
    for (const [name, pid] of [
      ["Sara", ids.sara],
      ["Pavol", ids.pavol],
      ["Rita", ids.rita],
      ["Otto", ids.otto],
    ] as const) {
      await client.studentProfile.create({
        data: {
          id: pid,
          schoolId,
          userId: await person(name, "STUDENT", schoolId),
        },
      });
    }
    await client.teacherProfile.create({
      data: {
        id: ids.foreignTeacher,
        schoolId: otherId,
        userId: await person("Olga", "TEACHER", otherId),
      },
    });
    await client.studentProfile.create({
      data: {
        id: ids.foreignStudent,
        schoolId: otherId,
        userId: await person("Oskar", "STUDENT", otherId),
      },
    });
    const level = await client.level.create({
      data: { schoolId, code: "B1", name: "B1", rank: 1 },
    });
    const foreignLevel = await client.level.create({
      data: { schoolId: otherId, code: "B1", name: "B1", rank: 1 },
    });
    const group = (
      gid: string,
      name: string,
      type: "GROUP" | "ONE_ON_ONE" = "GROUP",
    ) => ({
      id: gid,
      schoolId,
      levelId: level.id,
      type,
      name,
      capacity: type === "GROUP" ? 8 : 1,
    });
    await client.group.createMany({
      data: [
        group(ids.g1, "B1 Evening"),
        group(ids.g2, "B1 Morning"),
        group(ids.o1, "Otto 1-on-1", "ONE_ON_ONE"),
        {
          id: ids.foreignGroup,
          schoolId: otherId,
          levelId: foreignLevel.id,
          type: "GROUP",
          name: "Foreign",
          capacity: 8,
        },
      ],
    });
    const joined = new Date("2026-08-01T00:00:00Z");
    await client.groupMembership.createMany({
      data: [
        { schoolId, groupId: ids.g1, studentId: ids.sara, joinedAt: joined },
        { schoolId, groupId: ids.g1, studentId: ids.pavol, joinedAt: joined },
        { schoolId, groupId: ids.g2, studentId: ids.rita, joinedAt: joined },
        { schoolId, groupId: ids.o1, studentId: ids.otto, joinedAt: joined },
        {
          schoolId: otherId,
          groupId: ids.foreignGroup,
          studentId: ids.foreignStudent,
          joinedAt: joined,
        },
      ],
    });
    await client.room.create({
      data: {
        id: ids.room,
        schoolId,
        name: "Room 1",
        kind: "PHYSICAL",
        capacity: 8,
      },
    });
    const published = new Date("2026-08-20T00:00:00Z");
    await client.term.createMany({
      data: [
        {
          id: ids.term,
          schoolId,
          name: "Autumn 2026",
          startDate: new Date("2026-09-01"),
          endDate: new Date("2026-12-20"),
          timetablePublishedAt: published,
        },
        {
          id: ids.draft,
          schoolId,
          name: "Draft",
          startDate: new Date("2027-01-10"),
          endDate: new Date("2027-06-20"),
        },
        {
          id: ids.foreignTerm,
          schoolId: otherId,
          name: "Autumn 2026",
          startDate: new Date("2026-09-01"),
          endDate: new Date("2026-12-20"),
          timetablePublishedAt: published,
        },
      ],
    });
    const lesson = (
      lid: string,
      date: string,
      extra: Record<string, unknown> = {},
    ) => ({
      id: lid,
      schoolId,
      termId: ids.term,
      groupId: ids.g1,
      teacherId: ids.tomas,
      roomId: ids.room,
      startsAt: local(date, "17:00"),
      endsAt: local(date, "18:00"),
      ...extra,
    });
    const oneOnOne = { groupId: ids.o1, teacherId: ids.eva, roomId: null };
    await client.lesson.createMany({
      data: [
        lesson(lessons.l1, "2026-11-02"),
        lesson(lessons.l2, "2026-11-09"),
        lesson(lessons.l3, "2026-11-16"),
        lesson(lessons.l4, "2026-11-23"),
        lesson(lessons.l5, "2026-11-10", {
          status: "CANCELLED",
          cancelReason: "HOLIDAY",
        }),
        lesson(lessons.l6, "2026-11-12", { substituteTeacherId: ids.ana }),
        lesson(lessons.g2a, "2026-11-03", {
          groupId: ids.g2,
          teacherId: ids.eva,
        }),
        lesson(lessons.o1a, "2026-11-04", {
          ...oneOnOne,
          status: "CANCELLED",
          cancelReason: "STUDENT_CANCELLED",
        }),
        lesson(lessons.o1b, "2026-11-11", oneOnOne),
        lesson(lessons.draftLesson, "2026-11-05", { termId: ids.draft }),
        {
          id: lessons.foreign,
          schoolId: otherId,
          termId: ids.foreignTerm,
          groupId: ids.foreignGroup,
          teacherId: ids.foreignTeacher,
          startsAt: local("2026-11-02", "17:00"),
          endsAt: local("2026-11-02", "18:00"),
        },
      ],
    });
    // The makeup points at the lesson it replaces (unique index).
    await client.lesson.create({
      data: lesson(lessons.o1m, "2026-11-06", {
        ...oneOnOne,
        rescheduledFromId: lessons.o1a,
      }),
    });

    const absence = async (
      lessonId: string,
      studentId: string,
      credit: boolean,
    ) => {
      const report = await client.absenceReport.create({
        data: { schoolId, lessonId, studentId, reason: "Private reason" },
      });
      if (!credit) return null;
      return client.makeupCredit.create({
        data: {
          schoolId,
          studentId,
          sourceLessonId: lessonId,
          absenceReportId: report.id,
          status: "USED",
          usedAt: local("2026-11-04", "10:00"),
          expiresAt: local("2026-12-31", "00:00"),
        },
      });
    };
    await absence(lessons.l2, ids.pavol, true);
    await absence(lessons.o1a, ids.otto, true);
    const ritaCredit = await absence(lessons.g2a, ids.rita, true);
    await client.replacementRequest.create({
      data: {
        schoolId,
        studentId: ids.rita,
        originalLessonId: lessons.g2a,
        targetLessonId: lessons.l3,
        makeupCreditId: ritaCredit!.id,
      },
    });

    await seedBigSchool(bigId);
  }, 120_000);

  /** A full term: 40 groups × 2 lessons a week × 16 weeks, 6 students each. */
  async function seedBigSchool(bigId: string) {
    const level = await client.level.create({
      data: { schoolId: bigId, code: "A1", name: "A1", rank: 1 },
    });
    const term = await client.term.create({
      data: {
        schoolId: bigId,
        name: "Big term",
        startDate: new Date("2026-09-07"),
        endDate: new Date("2026-12-20"),
        timetablePublishedAt: new Date("2026-08-20T00:00:00Z"),
      },
    });
    const users = Array.from({ length: 260 }, (_, i) => ({
      id: id(),
      name: `Big ${i}`,
      email: `big-${i}-${suffix}@example.test`,
    }));
    await client.user.createMany({ data: users });
    const teacherUsers = users.slice(0, 20);
    const studentUsers = users.slice(20);
    await client.membership.createMany({
      data: users.map((u, i) => ({
        schoolId: bigId,
        userId: u.id,
        role: i < 20 ? ("TEACHER" as const) : ("STUDENT" as const),
      })),
    });
    const teachers = teacherUsers.map((u) => ({
      id: id(),
      schoolId: bigId,
      userId: u.id,
    }));
    const students = studentUsers.map((u) => ({
      id: id(),
      schoolId: bigId,
      userId: u.id,
    }));
    await client.teacherProfile.createMany({ data: teachers });
    await client.studentProfile.createMany({ data: students });
    const groups = Array.from({ length: 40 }, (_, i) => ({
      id: id(),
      schoolId: bigId,
      levelId: level.id,
      type: "GROUP" as const,
      name: `Big group ${i}`,
      capacity: 8,
    }));
    await client.group.createMany({ data: groups });
    await client.groupMembership.createMany({
      data: groups.flatMap((g, gi) =>
        students.slice(gi * 6, gi * 6 + 6).map((s) => ({
          schoolId: bigId,
          groupId: g.id,
          studentId: s.id,
          joinedAt: new Date("2026-08-01T00:00:00Z"),
        })),
      ),
    });
    const rows: {
      id: string;
      schoolId: string;
      termId: string;
      groupId: string;
      teacherId: string;
      startsAt: Date;
      endsAt: Date;
    }[] = [];
    groups.forEach((g, gi) => {
      for (let week = 0; week < 16; week++) {
        for (const day of [0, 2]) {
          const date = addDays("2026-09-07", week * 7 + day + (gi % 2));
          const start = local(
            date,
            `${String(8 + (gi % 10)).padStart(2, "0")}:00`,
          );
          rows.push({
            id: id(),
            schoolId: bigId,
            termId: term.id,
            groupId: g.id,
            teacherId: teachers[gi % 20].id,
            startsAt: start,
            endsAt: new Date(start.getTime() + 90 * 60_000),
          });
        }
      }
    });
    await client.lesson.createMany({ data: rows });
    await client.absenceReport.createMany({
      data: rows
        .filter((_, i) => i % 7 === 0)
        .map((l) => ({
          schoolId: bigId,
          lessonId: l.id,
          studentId:
            students[groups.findIndex((g) => g.id === l.groupId) * 6].id,
        })),
    });
  }

  afterAll(async () => {
    if (!client) return;
    const where = { where: { schoolId: { in: schools } } };
    await client.replacementRequest.deleteMany(where);
    await client.makeupCredit.deleteMany(where);
    await client.absenceReport.deleteMany(where);
    // Makeups reference the lesson they replace: delete them first.
    await client.lesson.deleteMany({
      where: { schoolId: { in: schools }, rescheduledFromId: { not: null } },
    });
    await client.lesson.deleteMany(where);
    await client.school.deleteMany({ where: { id: { in: schools } } });
    await client.user.deleteMany({
      where: {
        email: { endsWith: `-${suffix}@example.test` },
        memberships: { none: {} },
      },
    });
    await client.$disconnect();
  });

  const okResult = async <
    K extends "attendance" | "teacher-hours" | "teacher-hours-lessons",
  >(
    report: K,
    input = {},
    on = db,
  ) => {
    const loaded = await loadReportData(on, report, input, NOW);
    if (loaded.status !== "ok") throw new Error(loaded.code);
    return loaded;
  };

  it("builds the attendance report from absences, credits, replacements and reschedules", async () => {
    const loaded = await okResult("attendance");
    expect(loaded.period).toEqual({
      termId: ids.term,
      from: "2026-09-01",
      to: "2026-12-20",
    });
    expect(loaded.untilToday).toBe(true);
    expect(
      loaded.result.rows.map((r) => [
        r.groupName,
        r.studentName,
        r.expected,
        r.absent,
        r.absentWithCredit,
        r.attended,
        r.attendanceRate,
        r.makeupsAttended,
      ]),
    ).toEqual([
      ["B1 Evening", "Pavol", 4, 1, 1, 3, 750, 0],
      ["B1 Evening", "Sara", 4, 0, 0, 4, 1000, 0],
      ["B1 Morning", "Rita", 1, 1, 1, 0, 0, 1],
      ["Otto 1-on-1", "Otto", 2, 1, 1, 1, 500, 1],
    ]);
    // Never anything about absence reasons.
    expect(JSON.stringify(loaded)).not.toContain("Private reason");
  });

  it("counts teacher hours for the effective teacher", async () => {
    const loaded = await okResult("teacher-hours");
    expect(
      loaded.result.rows.map((r) => [
        r.name,
        r.lessons,
        r.regularMinutes,
        r.substituteMinutes,
        r.hours,
        r.coveredByOthersMinutes,
      ]),
    ).toEqual([
      ["Ana", 1, 0, 60, "1.00", 0],
      ["Eva", 3, 180, 0, "3.00", 0],
      ["Tomas", 3, 180, 0, "3.00", 60],
    ]);
    const lessonsOfAna = await okResult("teacher-hours-lessons", {
      teacherId: ids.ana,
    });
    expect(lessonsOfAna.result.summary?.totalMinutes).toBe(60);
    expect(lessonsOfAna.result.rows).toMatchObject([
      {
        lessonId: lessons.l6,
        date: "2026-11-12",
        start: "17:00",
        end: "18:00",
        role: "SUBSTITUTE",
        regularTeacherName: "Tomas",
        roomName: "Room 1",
      },
    ]);
  });

  it("the page loader and the export return the same rows, and each export is audited once", async () => {
    const before = await client.auditLog.count({
      where: { schoolId, action: "report.exported" },
    });
    for (const report of [
      "attendance",
      "teacher-hours",
      "teacher-hours-lessons",
    ] as const) {
      const input = { groupId: ids.g1 };
      const page = await okResult(report, input);
      const exported = await exportReportData(
        db,
        { userId: adminId, schoolId },
        report,
        input,
        NOW,
      );
      expect(exported.rows).toEqual(page.result.rows);
      expect(exported.period).toEqual(page.period);
    }
    const audits = await client.auditLog.findMany({
      where: { schoolId, action: "report.exported" },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(before + 3);
    expect(audits.at(-1)).toMatchObject({
      actorId: adminId,
      entityType: "School",
      entityId: schoolId,
      data: {
        report: "teacher-hours-lessons",
        input: { groupId: ids.g1 },
        rows: 4,
      },
    });
  });

  it("refuses another school's ids with NOT_FOUND", async () => {
    for (const input of [
      { teacherId: ids.foreignTeacher },
      { groupId: ids.foreignGroup },
      { studentId: ids.foreignStudent },
      { termId: ids.foreignTerm },
      { teacherId: randomUUID() },
    ]) {
      await expect(
        loadReportData(db, "attendance", input, NOW),
        JSON.stringify(input),
      ).rejects.toEqual(new ReportError("NOT_FOUND"));
      await expect(
        exportReportData(
          db,
          { userId: adminId, schoolId },
          "teacher-hours",
          input,
          NOW,
        ),
      ).rejects.toEqual(new ReportError("NOT_FOUND"));
    }
  });

  it("never shows another school's lessons or unpublished terms", async () => {
    const custom = { from: "2026-11-01", to: "2026-11-30" };
    const lessonsReport = await okResult("teacher-hours-lessons", custom);
    const lessonIds = lessonsReport.result.rows.map((r) => r.lessonId);
    expect(lessonIds).not.toContain(lessons.foreign);
    expect(lessonIds).not.toContain(lessons.draftLesson);
    expect(lessonIds).toHaveLength(7);
    const other = await okResult("teacher-hours", {}, otherDb);
    expect(other.result.rows.map((r) => r.name)).toEqual(["Olga"]);
    const otherAttendance = await okResult("attendance", {}, otherDb);
    expect(otherAttendance.result.rows.map((r) => r.studentName)).toEqual([
      "Oskar",
    ]);
  });

  it("reports range errors and a school without terms", async () => {
    const tooLong = await loadReportData(
      db,
      "attendance",
      { from: "2026-01-01", to: "2027-01-02" },
      NOW,
    );
    expect(tooLong).toMatchObject({ status: "error", code: "RANGE_TOO_LONG" });
    const backwards = await loadReportData(
      db,
      "teacher-hours",
      { from: "2026-11-02", to: "2026-11-01" },
      NOW,
    );
    expect(backwards).toMatchObject({ status: "error", code: "INVALID_RANGE" });
    await expect(
      exportReportData(
        db,
        { userId: adminId, schoolId },
        "attendance",
        { from: "2026-11-02", to: "2026-11-01" },
        NOW,
      ),
    ).rejects.toEqual(new ReportError("INVALID_RANGE"));
    const noTerm = await loadReportData(emptyDb, "teacher-hours", {}, NOW);
    expect(noTerm).toMatchObject({ status: "error", code: "NO_TERM" });
  });

  it("loads a full-term report in under 2 s", async () => {
    for (const report of [
      "attendance",
      "teacher-hours",
      "teacher-hours-lessons",
    ] as const) {
      const start = performance.now();
      const loaded = await okResult(report, {}, bigDb);
      const ms = performance.now() - start;
      expect(loaded.result.rows.length, report).toBeGreaterThan(0);
      expect(ms, `${report}: ${Math.round(ms)} ms`).toBeLessThan(2_000);
    }
  });
});
