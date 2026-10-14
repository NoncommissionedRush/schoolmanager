// An admin spends a student's makeup credit for them (CARM-47,
// docs/architecture/replacements.md §6 _Admin booking_, §7 _Admin
// reschedule_), and the teacher dashboard's counts of the resulting
// lessons (absences.md §6.3), against a real Postgres. Opt-in, like the other DB tests:
// set SCHEDULING_TEST_DATABASE_URL to a migrated database (never your dev
// database; the test creates and deletes its own schools).

import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { AdminError } from "@/server/admin/result";
import { scopeToSchool } from "@/server/db/school-scope";
import { zonedTimeToUtc } from "@/server/scheduling";
import { loadTeacherToday } from "@/server/lessons/teacher";
import type { SchoolDb } from "@/server/timetable/service";

import {
  bookReplacementForStudent,
  listAdminBookingOptions,
  listReviewQueue,
} from "./booking";
import { rescheduleByAdmin } from "./reschedule";
import { reportAbsence } from "./service";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
const TZ = "Europe/Bratislava";
const local = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return zonedTimeToUtc(date, h * 60 + m, TZ);
};
// Tue 20 Oct 2026, 12:00 local; the default cutoff is 24 hours and credits
// are valid for 30 days.
const NOW = local("2026-10-20", "12:00");

async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof AdminError) return error.error.key;
    throw error;
  }
}

describe.skipIf(!url)("admin spends a student's credit (database)", () => {
  let client: PrismaClient;
  let db: SchoolDb;
  let otherDb: SchoolDb;
  let schoolId: string;
  const schools: string[] = [];
  const users: string[] = [];
  const user: Record<string, string> = {};
  const ids = {
    tess: randomUUID(),
    cara: randomUUID(),
    dan: randomUUID(),
    eve: randomUUID(),
    olga: randomUUID(),
    b1: randomUUID(),
    b2: randomUUID(),
    groupA: randomUUID(), // B1: Cara and Dan
    groupB: randomUUID(), // B1: Eve, the replacement target
    groupC: randomUUID(), // B2
    oneOnOne: randomUUID(), // Olga, with Tess
    room: randomUUID(),
    booth: randomUUID(),
    term: randomUUID(),
  };
  const lessons = {
    aWed: randomUUID(), // Wed 21 Oct 17:00, group A
    aThu: randomUUID(), // Thu 22 Oct 17:00, group A
    bFri: randomUUID(), // Fri 23 Oct 10:00, group B
    bStarted: randomUUID(), // Tue 20 Oct 11:00, group B: started
    cFri: randomUUID(), // Fri 23 Oct 12:00, group C (B2)
    oThu: randomUUID(), // Thu 22 Oct 16:00, 1-on-1
    oFri: randomUUID(), // Fri 23 Oct 16:00, 1-on-1
  };
  const credits: Record<string, string> = {};

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    const suffix = randomUUID().slice(0, 8);
    const school = await client.school.create({
      data: { name: `Cred ${suffix}`, slug: `cred-${suffix}`, timezone: TZ },
    });
    const other = await client.school.create({
      data: {
        name: `Cred O ${suffix}`,
        slug: `cred-o-${suffix}`,
        timezone: TZ,
      },
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
      data: { id: ids.tess, schoolId, userId: await person("Tess", "TEACHER") },
    });
    await client.level.createMany({
      data: [
        { id: ids.b1, schoolId, code: "B1", name: "B1", rank: 1 },
        { id: ids.b2, schoolId, code: "B2", name: "B2", rank: 2 },
      ],
    });
    const student = async (id: string, name: string) => ({
      id,
      schoolId,
      levelId: ids.b1,
      userId: await person(name, "STUDENT"),
    });
    await client.studentProfile.createMany({
      data: [
        await student(ids.cara, "Cara"),
        await student(ids.dan, "Dan"),
        await student(ids.eve, "Eve"),
        await student(ids.olga, "Olga"),
      ],
    });
    await client.room.createMany({
      data: [
        { id: ids.room, schoolId, name: "Big", kind: "PHYSICAL", capacity: 10 },
        {
          id: ids.booth,
          schoolId,
          name: "Booth",
          kind: "PHYSICAL",
          capacity: 1,
        },
      ],
    });
    const group = (
      id: string,
      name: string,
      levelId: string,
      type: "GROUP" | "ONE_ON_ONE" = "GROUP",
    ) => ({
      id,
      schoolId,
      levelId,
      type,
      name,
      capacity: type === "ONE_ON_ONE" ? 1 : 8,
    });
    await client.group.createMany({
      data: [
        group(ids.groupA, "A Evening", ids.b1),
        group(ids.groupB, "B Morning", ids.b1),
        group(ids.groupC, "C Upper", ids.b2),
        group(ids.oneOnOne, "Olga 1-on-1", ids.b1, "ONE_ON_ONE"),
      ],
    });
    const joined = new Date("2026-09-01T00:00:00Z");
    const member = (groupId: string, studentId: string) => ({
      schoolId,
      groupId,
      studentId,
      joinedAt: joined,
    });
    await client.groupMembership.createMany({
      data: [
        member(ids.groupA, ids.cara),
        member(ids.groupA, ids.dan),
        member(ids.groupB, ids.eve),
        member(ids.oneOnOne, ids.olga),
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
      roomId: string,
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
        teacherId: ids.tess,
        roomId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + minutes * 60_000),
      };
    };
    const { groupA, groupB, groupC, oneOnOne, room, booth } = ids;
    await client.lesson.createMany({
      data: [
        lesson(lessons.aWed, groupA, room, "2026-10-21", "17:00", 90),
        lesson(lessons.aThu, groupA, room, "2026-10-22", "17:00", 90),
        lesson(lessons.bFri, groupB, room, "2026-10-23", "10:00", 90),
        lesson(lessons.bStarted, groupB, room, "2026-10-20", "11:00", 90),
        lesson(lessons.cFri, groupC, room, "2026-10-23", "12:00", 90),
        lesson(lessons.oThu, oneOnOne, booth, "2026-10-22", "16:00", 45),
        lesson(lessons.oFri, oneOnOne, booth, "2026-10-23", "16:00", 45),
      ],
    });

    // Credits: Cara and Dan miss group A lessons, Olga two 1-on-1s.
    const report = async (name: string, lessonId: string) => {
      const result = await reportAbsence(
        db,
        { userId: user[name], role: "STUDENT" },
        { lessonId, reason: null },
        NOW,
      );
      if (result.status !== "reported" || !result.credit) {
        throw new Error(`No credit for ${name}`);
      }
      return result.credit.id;
    };
    credits.cara = await report("Cara", lessons.aWed);
    credits.dan = await report("Dan", lessons.aThu);
    credits.olgaThu = await report("Olga", lessons.oThu);
    credits.olgaFri = await report("Olga", lessons.oFri);
  });

  afterAll(async () => {
    if (!client) return;
    for (const id of schools) {
      await client.auditLog.deleteMany({ where: { schoolId: id } });
      await client.replacementRequest.deleteMany({ where: { schoolId: id } });
      await client.makeupCredit.deleteMany({ where: { schoolId: id } });
      await client.absenceReport.deleteMany({ where: { schoolId: id } });
      // Reschedule chains: newest first (self-FK, onDelete: Restrict).
      for (let i = 0; i < 10; i++) {
        await client.lesson.deleteMany({
          where: { schoolId: id, rescheduledTo: null },
        });
      }
    }
    await client.school.deleteMany({ where: { id: { in: schools } } });
    await client.user.deleteMany({ where: { id: { in: users } } });
    await client.$disconnect();
  });

  const admin = () => ({ userId: user.Admin });

  describe("group credit: book a replacement for the student", () => {
    it("offers same-level lessons, and other levels only on Show all", async () => {
      const page = await listAdminBookingOptions(db, credits.cara, false, NOW);
      expect(page?.student.name).toBe("Cara");
      // Not her own group's lessons, the B2 group, or a started lesson.
      expect(page?.options.map((o) => o.id)).toEqual([lessons.bFri]);
      const all = await listAdminBookingOptions(db, credits.cara, true, NOW);
      expect(
        all?.options.map((o) => [o.id, o.reasons.map((r) => r.code)]),
      ).toEqual([
        [lessons.bFri, []],
        [lessons.cFri, ["LEVEL_MISMATCH"]],
      ]);
    });

    it("books an approved replacement and spends the credit", async () => {
      const result = await bookReplacementForStudent(
        db,
        admin(),
        {
          creditId: credits.cara,
          targetLessonId: lessons.bFri,
          acknowledgedKeys: [],
          note: "Phoned the office",
        },
        NOW,
      );
      expect(result.status).toBe("booked");
      if (result.status !== "booked") return;
      const booking = await client.replacementRequest.findUniqueOrThrow({
        where: { id: result.bookingId },
        include: { makeupCredit: true },
      });
      expect(booking).toMatchObject({
        studentId: ids.cara,
        originalLessonId: lessons.aWed,
        targetLessonId: lessons.bFri,
        status: "APPROVED",
        reviewedById: user.Admin,
        reviewNote: "Phoned the office",
      });
      expect(booking.makeupCredit.status).toBe("USED");
      // The admin already reviewed it: nothing waits in the queue.
      expect((await listReviewQueue(db, NOW)).map((r) => r.id)).not.toContain(
        result.bookingId,
      );
      const audit = await client.auditLog.findFirstOrThrow({
        where: { entityId: result.bookingId, action: "replacement.booked" },
      });
      expect(audit.actorId).toBe(user.Admin);
      expect(audit.data).toMatchObject({ byAdmin: true, acknowledged: [] });

      // Spent: a second booking with it is refused.
      expect(
        await bookReplacementForStudent(
          db,
          admin(),
          {
            creditId: credits.cara,
            targetLessonId: lessons.cFri,
            acknowledgedKeys: ["LEVEL_MISMATCH"],
            note: null,
          },
          NOW,
        ),
      ).toMatchObject({
        status: "refused",
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: "CREDIT_UNAVAILABLE" }),
        ]),
      });
    });

    it("books past overridable reasons only once each is acknowledged", async () => {
      const input = {
        creditId: credits.dan,
        targetLessonId: lessons.cFri,
        acknowledgedKeys: [] as string[],
        note: null,
      };
      const first = await bookReplacementForStudent(db, admin(), input, NOW);
      expect(first).toMatchObject({
        status: "refused",
        reasons: [expect.objectContaining({ code: "LEVEL_MISMATCH" })],
      });
      const credit = await client.makeupCredit.findUniqueOrThrow({
        where: { id: credits.dan },
      });
      expect(credit.status).toBe("AVAILABLE");

      const keys =
        first.status === "refused" ? first.reasons.map((r) => r.key) : [];
      const second = await bookReplacementForStudent(
        db,
        admin(),
        { ...input, acknowledgedKeys: keys },
        NOW,
      );
      expect(second.status).toBe("booked");
      if (second.status !== "booked") return;
      const booking = await client.replacementRequest.findUniqueOrThrow({
        where: { id: second.bookingId },
      });
      expect(booking.status).toBe("OVERRIDDEN");
      const audit = await client.auditLog.findFirstOrThrow({
        where: { entityId: second.bookingId, action: "replacement.booked" },
      });
      expect(audit.data).toMatchObject({
        byAdmin: true,
        acknowledged: [expect.objectContaining({ code: "LEVEL_MISMATCH" })],
      });
    });

    it("never overrides a blocking reason", async () => {
      // Eve's own group, and a lesson that has started.
      const eveCredit = await client.makeupCredit.create({
        data: {
          schoolId,
          studentId: ids.eve,
          sourceLessonId: lessons.bStarted,
          absenceReportId: (
            await client.absenceReport.create({
              data: {
                schoolId,
                lessonId: lessons.bStarted,
                studentId: ids.eve,
                reportedById: user.Eve,
              },
            })
          ).id,
          expiresAt: local("2026-11-20", "00:00"),
        },
      });
      for (const target of [lessons.bFri, lessons.bStarted]) {
        const result = await bookReplacementForStudent(
          db,
          admin(),
          {
            creditId: eveCredit.id,
            targetLessonId: target,
            acknowledgedKeys: [
              "ALREADY_ATTENDING",
              "LESSON_STARTED",
              "SAME_LESSON",
            ],
            note: null,
          },
          NOW,
        );
        expect(result.status).toBe("refused");
      }
      expect(
        (
          await client.makeupCredit.findUniqueOrThrow({
            where: { id: eveCredit.id },
          })
        ).status,
      ).toBe("AVAILABLE");
    });

    it("doesn't find 1-on-1 credits or another school's credits", async () => {
      const input = {
        targetLessonId: lessons.bFri,
        acknowledgedKeys: [],
        note: null,
      };
      expect(
        await refusal(() =>
          bookReplacementForStudent(
            db,
            admin(),
            { ...input, creditId: credits.olgaThu },
            NOW,
          ),
        ),
      ).toBe("common.error.notFound");
      expect(
        await refusal(() =>
          bookReplacementForStudent(
            otherDb,
            { userId: user.OtherAdmin },
            { ...input, creditId: credits.dan },
            NOW,
          ),
        ),
      ).toBe("common.error.notFound");
      expect(
        await listAdminBookingOptions(otherDb, credits.dan, true, NOW),
      ).toBeNull();
    });
  });

  describe("1-on-1 credit: reschedule for the student", () => {
    const move = {
      date: "2026-10-26",
      startMinute: 16 * 60,
      durationMinutes: 45,
      roomId: null as string | null,
      acknowledgedKeys: [] as string[],
      note: "Agreed by phone",
    };

    it("creates the new lesson in the chain and spends the credit", async () => {
      const result = await rescheduleByAdmin(
        db,
        admin(),
        { ...move, roomId: ids.booth, creditId: credits.olgaThu },
        NOW,
      );
      expect(result.status).toBe("rescheduled");
      if (result.status !== "rescheduled") return;
      const lesson = await client.lesson.findUniqueOrThrow({
        where: { id: result.lessonId },
      });
      expect(lesson).toMatchObject({
        groupId: ids.oneOnOne,
        teacherId: ids.tess,
        roomId: ids.booth,
        timetableSlotId: null,
        rescheduledFromId: lessons.oThu,
        status: "SCHEDULED",
        startsAt: local("2026-10-26", "16:00"),
      });
      const credit = await client.makeupCredit.findUniqueOrThrow({
        where: { id: credits.olgaThu },
      });
      expect(credit).toMatchObject({
        status: "USED",
        rescheduledLessonId: result.lessonId,
      });
      const audit = await client.auditLog.findFirstOrThrow({
        where: { entityId: result.lessonId, action: "lesson.rescheduled" },
      });
      expect(audit.actorId).toBe(user.Admin);
      expect(audit.data).toMatchObject({
        by: "admin",
        creditId: credits.olgaThu,
        creditSpent: true,
        fromLessonId: lessons.oThu,
        note: "Agreed by phone",
      });

      // The student's own cancel in time gives the same credit back (§3).
      const cancelled = await reportAbsence(
        db,
        { userId: user.Olga, role: "STUDENT" },
        { lessonId: result.lessonId, reason: null },
        NOW,
      );
      expect(cancelled).toMatchObject({
        status: "reported",
        credit: { id: credits.olgaThu },
        lessonCancelled: true,
      });
      expect(
        await client.makeupCredit.count({ where: { studentId: ids.olga } }),
      ).toBe(2);
    });

    it("asks to acknowledge a time after the credit expires", async () => {
      // Valid until 22 Nov (30 days after 23 Oct): 30 Nov is after.
      const late = { ...move, date: "2026-11-30", creditId: credits.olgaFri };
      const first = await rescheduleByAdmin(db, admin(), late, NOW);
      expect(first).toMatchObject({
        status: "conflicts",
        blocking: false,
        reasons: [expect.objectContaining({ code: "CREDIT_EXPIRES_FIRST" })],
      });
      expect(
        (
          await client.makeupCredit.findUniqueOrThrow({
            where: { id: credits.olgaFri },
          })
        ).status,
      ).toBe("AVAILABLE");
      const second = await rescheduleByAdmin(
        db,
        admin(),
        { ...late, acknowledgedKeys: ["CREDIT_EXPIRES_FIRST"] },
        NOW,
      );
      expect(second.status).toBe("rescheduled");
      const audit = await client.auditLog.findFirstOrThrow({
        where: {
          action: "lesson.rescheduled",
          entityId: second.status === "rescheduled" ? second.lessonId : "",
        },
      });
      expect(audit.data).toMatchObject({
        acknowledged: [{ type: "CREDIT_EXPIRES_FIRST" }],
      });
    });

    it("refuses spent, group and foreign credits, and past times", async () => {
      expect(
        await refusal(() =>
          rescheduleByAdmin(
            db,
            admin(),
            { ...move, creditId: credits.olgaFri },
            NOW,
          ),
        ),
      ).toBe("reschedule.errors.CREDIT_UNAVAILABLE");
      expect(
        await refusal(() =>
          rescheduleByAdmin(
            db,
            admin(),
            { ...move, creditId: credits.dan },
            NOW,
          ),
        ),
      ).toBe("common.error.notFound");
      expect(
        await refusal(() =>
          rescheduleByAdmin(
            otherDb,
            { userId: user.OtherAdmin },
            { ...move, creditId: credits.olgaThu },
            NOW,
          ),
        ),
      ).toBe("common.error.notFound");
      // The credit from Olga's cancelled rescheduled lesson is back; the
      // past is never a choice, acknowledged or not.
      const past = await rescheduleByAdmin(
        db,
        admin(),
        {
          ...move,
          date: "2026-10-20",
          startMinute: 9 * 60,
          creditId: credits.olgaThu,
          acknowledgedKeys: ["TOO_SOON"],
        },
        NOW,
      );
      expect(past).toMatchObject({ status: "conflicts", blocking: true });
    });
  });

  describe("teacher dashboard Today counts (absences.md §6.3)", () => {
    it("counts cancellations and replacements per lesson of the day", async () => {
      // Wednesday: Cara cancelled group A.
      const wed = await loadTeacherToday(
        db,
        ids.tess,
        local("2026-10-21", "08:00"),
        TZ,
      );
      expect(
        wed.map((l) => [l.groupName, l.notComing, l.replacements]),
      ).toEqual([["A Evening", 1, 0]]);

      // Friday: Cara (approved) and Dan (overridden) come as replacements;
      // Olga's 1-on-1 was cancelled and moved.
      const fri = await loadTeacherToday(
        db,
        ids.tess,
        local("2026-10-23", "08:00"),
        TZ,
      );
      expect(
        fri.map((l) => ({
          group: l.groupName,
          start: l.startMinute,
          cancelled: l.cancelled,
          counts: [l.notComing, l.replacements],
        })),
      ).toEqual([
        {
          group: "B Morning",
          start: 10 * 60,
          cancelled: false,
          counts: [0, 1],
        },
        { group: "C Upper", start: 12 * 60, cancelled: false, counts: [0, 1] },
        {
          group: "Olga 1-on-1",
          start: 16 * 60,
          cancelled: true,
          counts: [0, 0],
        },
      ]);
    });

    it("lists only the teacher's own lessons", async () => {
      expect(
        await loadTeacherToday(db, null, local("2026-10-23", "08:00"), TZ),
      ).toEqual([]);
      expect(
        await loadTeacherToday(
          otherDb,
          ids.tess,
          local("2026-10-23", "08:00"),
          TZ,
        ),
      ).toEqual([]);
    });
  });
});
