// Absences and makeup credits against a real Postgres
// (docs/architecture/replacements.md §3, §4, §8). Opt-in, like the other DB
// tests: set SCHEDULING_TEST_DATABASE_URL to a migrated database (never
// your dev database; the test creates and deletes its own schools).

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { createPgAdapter } from "@/lib/pg-adapter";
import { AdminError } from "@/server/admin/result";
import { scopeToSchool } from "@/server/db/school-scope";
import { zonedTimeToUtc } from "@/server/scheduling";
import type { SchoolDb } from "@/server/timetable/service";

import { deleteAbsence, expireCredits, reportAbsence } from "./service";
import {
  listAdminAbsences,
  listReportableLessons,
  loadLessonRoster,
  loadStudentAbsences,
} from "./views";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
const TZ = "Europe/Bratislava";
const local = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return zonedTimeToUtc(date, h * 60 + m, TZ);
};
// Tue 20 Oct 2026, 12:00 local; the default cutoff is 24 hours.
const NOW = local("2026-10-20", "12:00");

/** The i18n key of a refusal, or null when `fn` succeeds. */
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof AdminError) return error.error.key;
    throw error;
  }
}

describe.skipIf(!url)("absences & makeup credits (database)", () => {
  let client: PrismaClient;
  let db: SchoolDb;
  let otherDb: SchoolDb;
  let schoolId: string;
  const schools: string[] = [];
  const users: string[] = [];
  const user: Record<string, string> = {};
  const ids = {
    teacher: randomUUID(),
    cara: randomUUID(),
    dan: randomUUID(),
    olga: randomUUID(), // 1-on-1 student
    outsider: randomUUID(), // in no group
    group: randomUUID(),
    oneOnOne: randomUUID(),
    room: randomUUID(),
    term: randomUUID(),
  };
  // Group lessons (B1 Evening, 17:00–18:30) and 1-on-1 lessons (16:00–16:45).
  const lessons = {
    thu: randomUUID(), // Thu 22 Oct 17:00: well before the cutoff
    wed: randomUUID(), // Wed 21 Oct 12:00: cutoff exactly at NOW
    wedLate: randomUUID(), // Wed 21 Oct 11:59: cutoff a minute ago
    started: randomUUID(), // Tue 20 Oct 11:00: already started
    fri: randomUUID(), // Fri 23 Oct 17:00
    mon: randomUUID(), // Mon 26 Oct 17:00
    oneThu: randomUUID(), // Thu 22 Oct 16:00, 1-on-1
    oneWed: randomUUID(), // Wed 21 Oct 10:00, 1-on-1, after the cutoff
    oneFri: randomUUID(), // Fri 23 Oct 16:00, 1-on-1
    foreign: randomUUID(), // other school
  };

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: createPgAdapter(url),
    });
    const suffix = randomUUID().slice(0, 8);
    const school = await client.school.create({
      data: { name: `Abs ${suffix}`, slug: `abs-${suffix}`, timezone: TZ },
    });
    const other = await client.school.create({
      data: { name: `Abs O ${suffix}`, slug: `abs-o-${suffix}`, timezone: TZ },
    });
    schools.push(school.id, other.id);
    schoolId = school.id;
    db = scopeToSchool(client, schoolId);
    otherDb = scopeToSchool(client, other.id);

    const person = async (
      name: string,
      role: "ADMIN" | "TEACHER" | "STUDENT",
      inSchool = schoolId,
    ) => {
      const row = await client.user.create({
        data: { name, email: `${name.toLowerCase()}-${suffix}@example.test` },
      });
      users.push(row.id);
      user[name] = row.id;
      await client.membership.create({
        data: { schoolId: inSchool, userId: row.id, role },
      });
      return row.id;
    };
    await person("Admin", "ADMIN");
    await person("OtherAdmin", "ADMIN", other.id);
    await client.teacherProfile.create({
      data: {
        id: ids.teacher,
        schoolId,
        userId: await person("Tess", "TEACHER"),
      },
    });
    await client.studentProfile.createMany({
      data: [
        { id: ids.cara, schoolId, userId: await person("Cara", "STUDENT") },
        { id: ids.dan, schoolId, userId: await person("Dan", "STUDENT") },
        { id: ids.olga, schoolId, userId: await person("Olga", "STUDENT") },
        {
          id: ids.outsider,
          schoolId,
          userId: await person("Otto", "STUDENT"),
        },
      ],
    });
    const level = await client.level.create({
      data: { schoolId, code: "B1", name: "B1", rank: 1 },
    });
    await client.room.create({
      data: {
        id: ids.room,
        schoolId,
        name: "Room 1",
        kind: "PHYSICAL",
        capacity: 2,
      },
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
          id: ids.oneOnOne,
          schoolId,
          levelId: level.id,
          type: "ONE_ON_ONE",
          name: "Olga 1-on-1",
          capacity: 1,
        },
      ],
    });
    const joined = new Date("2026-09-01T00:00:00Z");
    await client.groupMembership.createMany({
      data: [
        { schoolId, groupId: ids.group, studentId: ids.cara, joinedAt: joined },
        { schoolId, groupId: ids.group, studentId: ids.dan, joinedAt: joined },
        {
          schoolId,
          groupId: ids.oneOnOne,
          studentId: ids.olga,
          joinedAt: joined,
        },
      ],
    });
    await client.term.create({
      data: {
        id: ids.term,
        schoolId,
        name: "Autumn",
        startDate: new Date("2026-09-14T00:00:00Z"),
        endDate: new Date("2026-12-18T00:00:00Z"),
        timetablePublishedAt: new Date("2026-09-01T00:00:00Z"),
      },
    });
    const lesson = (
      id: string,
      groupId: string,
      date: string,
      start: string,
      minutes: number,
    ) => {
      const startsAt = local(date, start);
      return {
        id,
        schoolId,
        termId: ids.term,
        groupId,
        teacherId: ids.teacher,
        roomId: ids.room,
        startsAt,
        endsAt: new Date(startsAt.getTime() + minutes * 60_000),
      };
    };
    await client.lesson.createMany({
      data: [
        lesson(lessons.thu, ids.group, "2026-10-22", "17:00", 90),
        lesson(lessons.wed, ids.group, "2026-10-21", "12:00", 90),
        lesson(lessons.wedLate, ids.group, "2026-10-21", "11:59", 1),
        lesson(lessons.started, ids.group, "2026-10-20", "11:00", 90),
        lesson(lessons.fri, ids.group, "2026-10-23", "17:00", 90),
        lesson(lessons.mon, ids.group, "2026-10-26", "17:00", 90),
        lesson(lessons.oneThu, ids.oneOnOne, "2026-10-22", "16:00", 45),
        lesson(lessons.oneWed, ids.oneOnOne, "2026-10-21", "10:00", 45),
        lesson(lessons.oneFri, ids.oneOnOne, "2026-10-23", "16:00", 45),
      ],
    });
    // Another school's lesson, for "not found".
    const otherLevel = await client.level.create({
      data: { schoolId: other.id, code: "B1", name: "B1", rank: 1 },
    });
    const otherTeacher = await client.teacherProfile.create({
      data: {
        schoolId: other.id,
        userId: await person("Ty", "TEACHER", other.id),
      },
    });
    const otherGroup = await client.group.create({
      data: {
        schoolId: other.id,
        levelId: otherLevel.id,
        type: "GROUP",
        name: "Foreign",
        capacity: 8,
      },
    });
    const otherTerm = await client.term.create({
      data: {
        schoolId: other.id,
        name: "Autumn",
        startDate: new Date("2026-09-14T00:00:00Z"),
        endDate: new Date("2026-12-18T00:00:00Z"),
        timetablePublishedAt: new Date("2026-09-01T00:00:00Z"),
      },
    });
    await client.lesson.create({
      data: {
        id: lessons.foreign,
        schoolId: other.id,
        termId: otherTerm.id,
        groupId: otherGroup.id,
        teacherId: otherTeacher.id,
        startsAt: local("2026-10-22", "17:00"),
        endsAt: local("2026-10-22", "18:30"),
      },
    });
  });

  afterAll(async () => {
    if (!client) return;
    const where = { where: { schoolId: { in: schools } } };
    await client.makeupCredit.deleteMany(where);
    await client.absenceReport.deleteMany(where);
    await client.lesson.deleteMany(where);
    await client.school.deleteMany({ where: { id: { in: schools } } });
    await client.user.deleteMany({ where: { id: { in: users } } });
    await client.$disconnect();
  });

  const student = (name: string) => ({
    userId: user[name],
    role: "STUDENT" as const,
  });
  const admin = () => ({ userId: user.Admin, role: "ADMIN" as const });

  it("before the cutoff: a report by the student and an AVAILABLE credit", async () => {
    const result = await reportAbsence(
      db,
      student("Cara"),
      { lessonId: lessons.thu, reason: "Doctor", expectCredit: true },
      NOW,
    );
    expect(result).toMatchObject({
      status: "reported",
      studentName: "Cara",
      credit: { validUntil: "2026-11-21" },
      lessonCancelled: false,
    });
    const report = await db.absenceReport.findFirstOrThrow({
      where: { lessonId: lessons.thu, studentId: ids.cara },
      include: { makeupCredit: true },
    });
    expect(report.reportedById).toBe(user.Cara);
    expect(report.reason).toBe("Doctor");
    expect(report.createdAt).toEqual(NOW);
    expect(report.makeupCredit).toMatchObject({
      status: "AVAILABLE",
      sourceLessonId: lessons.thu,
      expiresAt: local("2026-11-22", "00:00"),
    });
    expect(
      await db.auditLog.count({
        where: { action: "absence.reported", entityId: report.id },
      }),
    ).toBe(1);
    // A group lesson runs for the others.
    const lesson = await db.lesson.findUniqueOrThrow({
      where: { id: lessons.thu },
    });
    expect(lesson.status).toBe("SCHEDULED");
  });

  it("exactly at the cutoff still earns a credit", async () => {
    const result = await reportAbsence(
      db,
      student("Cara"),
      { lessonId: lessons.wed, reason: null },
      NOW,
    );
    expect(result).toMatchObject({ status: "reported" });
    expect(result.status === "reported" && result.credit).not.toBeNull();
  });

  it("after the cutoff: the report only, and a promised credit is not given silently", async () => {
    const promised = await reportAbsence(
      db,
      student("Cara"),
      { lessonId: lessons.wedLate, reason: null, expectCredit: true },
      NOW,
    );
    expect(promised).toEqual({ status: "cutoffPassed" });
    expect(
      await db.absenceReport.count({ where: { lessonId: lessons.wedLate } }),
    ).toBe(0);

    const late = await reportAbsence(
      db,
      student("Cara"),
      { lessonId: lessons.wedLate, reason: null },
      NOW,
    );
    expect(late).toMatchObject({ status: "reported", credit: null });
    expect(
      await db.makeupCredit.count({
        where: { sourceLessonId: lessons.wedLate },
      }),
    ).toBe(0);
  });

  it("an admin reports for a student with the same rules; a teacher can't", async () => {
    const result = await reportAbsence(
      db,
      admin(),
      { lessonId: lessons.fri, studentId: ids.dan, reason: "Phoned in" },
      NOW,
    );
    expect(result).toMatchObject({ status: "reported", studentName: "Dan" });
    const report = await db.absenceReport.findFirstOrThrow({
      where: { lessonId: lessons.fri, studentId: ids.dan },
    });
    expect(report.reportedById).toBe(user.Admin);

    expect(
      await refusal(() =>
        reportAbsence(
          db,
          { userId: user.Tess, role: "TEACHER" },
          { lessonId: lessons.mon, studentId: ids.dan, reason: null },
          NOW,
        ),
      ),
    ).toBe("absences.errors.FORBIDDEN");
    expect(
      await db.absenceReport.count({ where: { lessonId: lessons.mon } }),
    ).toBe(0);
  });

  it("refuses lessons the student isn't in, started ones and duplicates", async () => {
    expect(
      await refusal(() =>
        reportAbsence(
          db,
          student("Otto"),
          { lessonId: lessons.mon, reason: null },
          NOW,
        ),
      ),
    ).toBe("common.error.notFound");
    expect(
      await refusal(() =>
        reportAbsence(
          db,
          student("Cara"),
          { lessonId: lessons.foreign, reason: null },
          NOW,
        ),
      ),
    ).toBe("common.error.notFound");
    // A student can't report for someone else.
    expect(
      await refusal(() =>
        reportAbsence(
          db,
          student("Cara"),
          { lessonId: lessons.mon, studentId: ids.dan, reason: null },
          NOW,
        ),
      ),
    ).toBe("common.error.notFound");
    expect(
      await refusal(() =>
        reportAbsence(
          db,
          student("Cara"),
          { lessonId: lessons.started, reason: null },
          NOW,
        ),
      ),
    ).toBe("absences.errors.LESSON_STARTED");
    expect(
      await refusal(() =>
        reportAbsence(
          db,
          student("Cara"),
          { lessonId: lessons.thu, reason: null },
          NOW,
        ),
      ),
    ).toBe("absences.errors.ALREADY_REPORTED");
    // Malformed ids read as "not found" (CARM-32).
    expect(
      await refusal(() =>
        reportAbsence(
          db,
          student("Cara"),
          { lessonId: "nope", reason: null },
          NOW,
        ),
      ),
    ).toBe("common.error.notFound");
  });

  it("an admin of another school can't report on this school's lessons", async () => {
    expect(
      await refusal(() =>
        reportAbsence(
          otherDb,
          { userId: user.OtherAdmin, role: "ADMIN" },
          { lessonId: lessons.mon, studentId: ids.cara, reason: null },
          NOW,
        ),
      ),
    ).toBe("common.error.notFound");
  });

  it("two concurrent reports of the same absence: exactly one succeeds", async () => {
    const results = await Promise.allSettled([
      reportAbsence(
        db,
        student("Dan"),
        { lessonId: lessons.mon, reason: null },
        NOW,
      ),
      reportAbsence(
        db,
        admin(),
        { lessonId: lessons.mon, studentId: ids.dan, reason: null },
        NOW,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await db.makeupCredit.count({ where: { sourceLessonId: lessons.mon } }),
    ).toBe(1);
  });

  it("1-on-1: before the cutoff the lesson is cancelled, after it it stays", async () => {
    const early = await reportAbsence(
      db,
      student("Olga"),
      { lessonId: lessons.oneThu, reason: "Exam" },
      NOW,
    );
    expect(early).toMatchObject({ status: "reported", lessonCancelled: true });
    expect(
      await db.lesson.findUniqueOrThrow({ where: { id: lessons.oneThu } }),
    ).toMatchObject({ status: "CANCELLED", cancelReason: "STUDENT_CANCELLED" });

    const late = await reportAbsence(
      db,
      student("Olga"),
      { lessonId: lessons.oneWed, reason: null },
      NOW,
    );
    expect(late).toMatchObject({ credit: null, lessonCancelled: false });
    expect(
      await db.lesson.findUniqueOrThrow({ where: { id: lessons.oneWed } }),
    ).toMatchObject({ status: "SCHEDULED", cancelReason: null });
  });

  it("shows the student their credits and cancellations, and teachers the roster", async () => {
    const view = await loadStudentAbsences(
      db,
      { id: ids.cara, userId: user.Cara },
      { shownHistory: 20 },
      NOW,
    );
    expect(view.policy).toEqual({ hours: 24, days: 30, cutoffMinutes: 1440 });
    expect(view.credits.map((c) => c.sourceDate)).toEqual([
      "2026-10-21",
      "2026-10-22",
    ]);
    expect(view.upcoming.map((c) => [c.date, c.credit, c.byOffice])).toEqual([
      ["2026-10-21", false, false],
      ["2026-10-21", true, false],
      ["2026-10-22", true, false],
    ]);

    const roster = await loadLessonRoster(db, lessons.fri, NOW);
    expect(roster?.coming.map((s) => s.name)).toEqual(["Cara"]);
    expect(roster?.notComing).toEqual([
      expect.objectContaining({
        name: "Dan",
        reason: "Phoned in",
        viaOffice: true,
        late: false,
      }),
    ]);
    expect(roster?.seatsTaken).toBe(1);

    const one = await loadLessonRoster(db, lessons.oneThu, NOW);
    expect(one?.oneOnOneCancelled).toEqual({ name: "Olga", reason: "Exam" });

    // The admin's lesson picker skips cancelled and started lessons.
    const reportable = await listReportableLessons(db, ids.cara, NOW);
    expect(reportable?.lessons.map((l) => [l.id, l.alreadyCancelled])).toEqual([
      [lessons.wedLate, true],
      [lessons.wed, true],
      [lessons.thu, true],
      [lessons.fri, false],
      [lessons.mon, false],
    ]);
  });

  it("lists absences for admins of this school only", async () => {
    const filters = { from: "2026-10-19", to: "2026-10-30", page: 1 };
    const mine = await listAdminAbsences(db, filters, NOW);
    expect(mine.total).toBe(7);
    const byOffice = mine.rows.find((r) => r.lesson.id === lessons.fri);
    expect(byOffice?.byAdmin).toBe("Admin");
    expect(
      (await listAdminAbsences(db, { ...filters, studentId: ids.olga }, NOW))
        .total,
    ).toBe(2);
    expect((await listAdminAbsences(otherDb, filters, NOW)).total).toBe(0);
  });

  it("expires credits lazily, per school, with the request's clock", async () => {
    const credit = await db.makeupCredit.findFirstOrThrow({
      where: { sourceLessonId: lessons.wed },
    });
    expect(await expireCredits(otherDb, credit.expiresAt)).toBe(0);
    expect(
      await expireCredits(db, new Date(credit.expiresAt.getTime() - 1)),
    ).toBe(0);
    expect(await expireCredits(db, credit.expiresAt)).toBeGreaterThan(0);
    expect(
      (await db.makeupCredit.findUniqueOrThrow({ where: { id: credit.id } }))
        .status,
    ).toBe("EXPIRED");
  });

  it("admin delete: the report and its credit go; a used credit refuses", async () => {
    const report = await db.absenceReport.findFirstOrThrow({
      where: { lessonId: lessons.thu, studentId: ids.cara },
      include: { makeupCredit: true },
    });
    await db.makeupCredit.update({
      where: { id: report.makeupCredit!.id },
      data: { status: "USED", usedAt: NOW },
    });
    expect(
      await refusal(() =>
        deleteAbsence(db, { userId: user.Admin }, report.id, [], NOW),
      ),
    ).toBe("absences.errors.ABSENCE_CREDIT_USED");
    await db.makeupCredit.update({
      where: { id: report.makeupCredit!.id },
      data: { status: "AVAILABLE", usedAt: null },
    });

    // Another school's admin can't see it.
    expect(
      await refusal(() =>
        deleteAbsence(otherDb, { userId: user.OtherAdmin }, report.id, [], NOW),
      ),
    ).toBe("common.error.notFound");

    const result = await deleteAbsence(
      db,
      { userId: user.Admin },
      report.id,
      [],
      NOW,
    );
    expect(result).toMatchObject({ status: "deleted", overCapacity: null });
    expect(await db.absenceReport.count({ where: { id: report.id } })).toBe(0);
    expect(
      await db.makeupCredit.count({ where: { id: report.makeupCredit!.id } }),
    ).toBe(0);
    expect(
      await db.auditLog.count({
        where: { action: "absence.deleted", entityId: report.id },
      }),
    ).toBe(1);
  });

  it("admin delete: a group lesson can end up over its room's capacity", async () => {
    // Room 1 holds 2; Cara and Dan are members, plus one replacement.
    const report = await db.absenceReport.findFirstOrThrow({
      where: { lessonId: lessons.fri, studentId: ids.dan },
    });
    const credit = await reportAbsence(
      db,
      student("Olga"),
      { lessonId: lessons.oneFri, reason: null },
      NOW,
    );
    expect(credit.status).toBe("reported");
    const olgaCredit = await db.makeupCredit.findFirstOrThrow({
      where: { sourceLessonId: lessons.oneFri },
    });
    await db.replacementRequest.create({
      data: {
        schoolId,
        studentId: ids.olga,
        originalLessonId: lessons.oneFri,
        targetLessonId: lessons.fri,
        makeupCreditId: olgaCredit.id,
      },
    });
    const result = await deleteAbsence(
      db,
      { userId: user.Admin },
      report.id,
      [],
      NOW,
    );
    expect(result).toMatchObject({
      status: "deleted",
      overCapacity: { group: "B1 Evening", taken: 3, capacity: 2 },
    });
    await db.replacementRequest.deleteMany({
      where: { targetLessonId: lessons.fri },
    });
  });

  it("admin delete: a cancelled 1-on-1 comes back only without blocking conflicts", async () => {
    const report = await db.absenceReport.findFirstOrThrow({
      where: { lessonId: lessons.oneThu },
    });
    // The teacher's time was given to someone else meanwhile.
    const clash = await db.lesson.create({
      data: {
        schoolId,
        termId: ids.term,
        groupId: ids.group,
        teacherId: ids.teacher,
        startsAt: local("2026-10-22", "16:00"),
        endsAt: local("2026-10-22", "16:45"),
      },
    });
    const refused = await deleteAbsence(
      db,
      { userId: user.Admin },
      report.id,
      [],
      NOW,
    );
    expect(refused).toMatchObject({
      status: "conflicts",
      reason: "BLOCKING_CONFLICTS",
    });
    expect(await db.absenceReport.count({ where: { id: report.id } })).toBe(1);

    await db.lesson.delete({ where: { id: clash.id } });
    const result = await deleteAbsence(
      db,
      { userId: user.Admin },
      report.id,
      [],
      NOW,
    );
    expect(result).toMatchObject({ status: "deleted", lessonRestored: true });
    expect(
      await db.lesson.findUniqueOrThrow({ where: { id: lessons.oneThu } }),
    ).toMatchObject({ status: "SCHEDULED", cancelReason: null });
  });
});
