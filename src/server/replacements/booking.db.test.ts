// Replacement booking, admin review and 1-on-1 reschedules against a real
// Postgres (docs/architecture/replacements.md §4–§8). Opt-in, like the other
// DB tests: set SCHEDULING_TEST_DATABASE_URL to a migrated database (never
// your dev database; the test creates and deletes its own schools).

import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { AdminError } from "@/server/admin/result";
import { scopeToSchool } from "@/server/db/school-scope";
import { loadStudentLesson, loadStudentScope } from "@/server/lessons/student";
import { validUntilOf, zonedTimeToUtc } from "@/server/scheduling";
import { loadWeek } from "@/server/timetable/views";
import type { SchoolDb } from "@/server/timetable/service";

import {
  approveReplacements,
  bookReplacement,
  cancelBooking,
  listReviewQueue,
  loadBookingPage,
  overrideReplacement,
  rejectReplacement,
} from "./booking";
import { releaseCancelledLessons } from "./release";
import {
  cancelRescheduledLesson,
  loadRescheduleSheet,
  rescheduleByAdmin,
  rescheduleLesson,
} from "./reschedule";
import { reportAbsence } from "./service";
import { loadLessonRoster, loadStudentAbsences } from "./views";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
const TZ = "Europe/Bratislava";
const local = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return zonedTimeToUtc(date, h * 60 + m, TZ);
};
// Tue 20 Oct 2026, 12:00 local; the default cutoff is 24 hours.
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

describe.skipIf(!url)("replacements & reschedules (database)", () => {
  let client: PrismaClient;
  let db: SchoolDb;
  let otherDb: SchoolDb;
  let schoolId: string;
  const schools: string[] = [];
  const users: string[] = [];
  const user: Record<string, string> = {};
  const ids = {
    tess: randomUUID(),
    tom: randomUUID(),
    cara: randomUUID(),
    dan: randomUUID(),
    eve: randomUUID(),
    finn: randomUUID(),
    olga: randomUUID(),
    b1: randomUUID(),
    b2: randomUUID(),
    groupA: randomUUID(), // B1, Cara and Dan
    groupB: randomUUID(), // B1, Eve and Finn: the replacement target
    groupC: randomUUID(), // B2
    oneOnOne: randomUUID(), // Olga, with Tess
    small: randomUUID(), // capacity 3
    big: randomUUID(), // capacity 10
    oneRoom: randomUUID(),
    term: randomUUID(),
  };
  const lessons = {
    aWed: randomUUID(), // Wed 21 Oct 17:00, group A
    aMon: randomUUID(), // Mon 26 Oct 17:00, group A
    bTue: randomUUID(), // Tue 20 Oct 18:00, group B: cutoff passed
    bThu: randomUUID(), // Thu 22 Oct 10:00, group B, small room (1 free seat)
    bFri: randomUUID(), // Fri 23 Oct 10:00, group B, big room
    cThu: randomUUID(), // Thu 22 Oct 12:00, group C (B2), big room
    oThu: randomUUID(), // Thu 22 Oct 16:00, 1-on-1
    oWed: randomUUID(), // Wed 21 Oct 10:00, 1-on-1, after the cutoff
    oFri: randomUUID(), // Fri 23 Oct 16:00, 1-on-1
    foreign: randomUUID(),
  };

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    const suffix = randomUUID().slice(0, 8);
    const school = await client.school.create({
      data: { name: `Rep ${suffix}`, slug: `rep-${suffix}`, timezone: TZ },
    });
    const other = await client.school.create({
      data: { name: `Rep O ${suffix}`, slug: `rep-o-${suffix}`, timezone: TZ },
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
    await client.teacherProfile.createMany({
      data: [
        { id: ids.tess, schoolId, userId: await person("Tess", "TEACHER") },
        { id: ids.tom, schoolId, userId: await person("Tom", "TEACHER") },
      ],
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
        await student(ids.finn, "Finn"),
        await student(ids.olga, "Olga"),
      ],
    });
    await client.room.createMany({
      data: [
        {
          id: ids.small,
          schoolId,
          name: "Small",
          kind: "PHYSICAL",
          capacity: 3,
        },
        { id: ids.big, schoolId, name: "Big", kind: "PHYSICAL", capacity: 10 },
        {
          id: ids.oneRoom,
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
        member(ids.groupB, ids.finn),
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
      teacherId: string,
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
        teacherId,
        roomId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + minutes * 60_000),
      };
    };
    const { groupA, groupB, groupC, oneOnOne, tess, tom, small, big } = ids;
    await client.lesson.createMany({
      data: [
        lesson(lessons.aWed, groupA, tess, big, "2026-10-21", "17:00", 90),
        lesson(lessons.aMon, groupA, tess, big, "2026-10-26", "17:00", 90),
        lesson(lessons.bTue, groupB, tom, big, "2026-10-20", "18:00", 90),
        lesson(lessons.bThu, groupB, tom, small, "2026-10-22", "10:00", 90),
        lesson(lessons.bFri, groupB, tom, big, "2026-10-23", "10:00", 90),
        lesson(lessons.cThu, groupC, tom, big, "2026-10-22", "12:00", 90),
        lesson(
          lessons.oThu,
          oneOnOne,
          tess,
          ids.oneRoom,
          "2026-10-22",
          "16:00",
          45,
        ),
        lesson(
          lessons.oWed,
          oneOnOne,
          tess,
          ids.oneRoom,
          "2026-10-21",
          "10:00",
          45,
        ),
        lesson(
          lessons.oFri,
          oneOnOne,
          tess,
          ids.oneRoom,
          "2026-10-23",
          "16:00",
          45,
        ),
      ],
    });
    // A teacher note on the target lesson: never for the replacement student.
    await client.teacherNote.create({
      data: {
        schoolId,
        authorId: ids.tom,
        lessonId: lessons.bThu,
        body: "SECRET-NOTE-CARM-43",
      },
    });
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
        startsAt: local("2026-10-22", "10:00"),
        endsAt: local("2026-10-22", "11:30"),
      },
    });
  });

  afterAll(async () => {
    if (!client) return;
    const where = { where: { schoolId: { in: schools } } };
    await client.replacementRequest.deleteMany(where);
    await client.makeupCredit.deleteMany(where);
    await client.absenceReport.deleteMany(where);
    await client.teacherNote.deleteMany(where);
    await client.lesson.updateMany({
      ...where,
      data: { rescheduledFromId: null },
    });
    await client.lesson.deleteMany(where);
    await client.school.deleteMany({ where: { id: { in: schools } } });
    await client.user.deleteMany({ where: { id: { in: users } } });
    await client.$disconnect();
  });

  const asStudent = (name: string) => ({
    userId: user[name],
    role: "STUDENT" as const,
  });
  const admin = () => ({ userId: user.Admin });
  const creditOf = async (studentId: string, lessonId: string) =>
    client.makeupCredit.findFirstOrThrow({
      where: { studentId, sourceLessonId: lessonId },
    });
  const credits: Record<string, string> = {};
  const bookings: Record<string, string> = {};

  // --- Group replacements ---------------------------------------------------

  it("lists the lessons a credit can book: same level, free seat, not their own group", async () => {
    for (const name of ["Cara", "Dan"]) {
      await reportAbsence(
        db,
        asStudent(name),
        { lessonId: lessons.aWed, reason: null, expectCredit: true },
        NOW,
      );
    }
    credits.cara = (await creditOf(ids.cara, lessons.aWed)).id;
    credits.dan = (await creditOf(ids.dan, lessons.aWed)).id;
    const page = await loadBookingPage(
      db,
      { userId: user.Cara },
      credits.cara,
      NOW,
    );
    expect(page.state).toBe("ok");
    if (page.state !== "ok") return;
    expect(page.lessons.map((l) => l.id)).toEqual([
      lessons.bTue,
      lessons.bThu,
      lessons.bFri,
    ]);
    // A student-safe DTO: a seat count, no names of other students.
    expect(page.lessons[1]).toMatchObject({
      groupName: "B Morning",
      roomName: "Small",
      teacherName: "Tom",
      seatsLeft: 1,
    });
    expect(JSON.stringify(page)).not.toMatch(/Eve|Finn|Dan/);
    // Someone else's credit doesn't exist for Cara.
    expect(
      await loadBookingPage(db, { userId: user.Cara }, credits.dan, NOW),
    ).toEqual({ state: "notFound" });
  });

  it("two students booking the last seat at once: exactly one gets it", async () => {
    const results = await Promise.all([
      bookReplacement(
        db,
        { userId: user.Cara },
        { creditId: credits.cara, targetLessonId: lessons.bThu },
        NOW,
      ),
      bookReplacement(
        db,
        { userId: user.Dan },
        { creditId: credits.dan, targetLessonId: lessons.bThu },
        NOW,
      ),
    ]);
    const booked = results.filter((r) => r.status === "booked");
    const refused = results.filter((r) => r.status === "refused");
    expect(booked).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      reasons: [{ code: "ROOM_FULL", taken: 4, capacity: 3 }],
    });
    const winner = results[0].status === "booked" ? "Cara" : "Dan";
    const loser = winner === "Cara" ? "Dan" : "Cara";
    bookings.winner = (booked[0] as { bookingId: string }).bookingId;
    credits.winner = credits[winner.toLowerCase()];
    credits.loser = credits[loser.toLowerCase()];
    user.Winner = user[winner];
    user.Loser = user[loser];
    const row = await client.replacementRequest.findUniqueOrThrow({
      where: { id: bookings.winner },
      include: { makeupCredit: true },
    });
    expect(row).toMatchObject({
      status: "AUTO_APPROVED",
      originalLessonId: lessons.aWed,
      targetLessonId: lessons.bThu,
      makeupCreditId: credits.winner,
    });
    expect(row.makeupCredit).toMatchObject({ status: "USED", usedAt: NOW });
    expect(
      await client.auditLog.count({
        where: { schoolId, action: "replacement.booked", entityId: row.id },
      }),
    ).toBe(1);
  });

  it("one credit spent from two transactions: exactly one booking", async () => {
    const results = await Promise.all(
      [lessons.bFri, lessons.bTue].map((targetLessonId) =>
        bookReplacement(
          db,
          { userId: user.Loser },
          { creditId: credits.loser, targetLessonId },
          NOW,
        ).catch((error: unknown) => error),
      ),
    );
    const booked = results.filter(
      (r) => (r as { status?: string }).status === "booked",
    );
    expect(booked).toHaveLength(1);
    expect(
      await client.replacementRequest.count({
        where: { makeupCreditId: credits.loser },
      }),
    ).toBe(1);
    // Put the loser on Friday for the next tests, whatever won.
    const row = await client.replacementRequest.findFirstOrThrow({
      where: { makeupCreditId: credits.loser },
    });
    if (row.targetLessonId !== lessons.bFri) {
      await cancelBooking(
        db,
        { userId: user.Loser },
        row.id,
        local("2026-10-20", "12:00"),
      );
      await client.replacementRequest.delete({ where: { id: row.id } });
      await client.makeupCredit.update({
        where: { id: credits.loser },
        data: { status: "AVAILABLE", usedAt: null },
      });
      const again = await bookReplacement(
        db,
        { userId: user.Loser },
        { creditId: credits.loser, targetLessonId: lessons.bFri },
        NOW,
      );
      expect(again.status).toBe("booked");
      bookings.loser = (again as { bookingId: string }).bookingId;
    } else {
      bookings.loser = row.id;
    }
  });

  it("the teacher sees the replacement student, marked, and the seats", async () => {
    const roster = await loadLessonRoster(db, lessons.bThu, NOW);
    const winnerName = user.Winner === user.Cara ? "Cara" : "Dan";
    expect(roster?.coming).toEqual([
      {
        id: expect.any(String),
        name: winnerName,
        replacementFrom: "A Evening",
      },
      expect.objectContaining({ name: "Eve", replacementFrom: null }),
      expect.objectContaining({ name: "Finn", replacementFrom: null }),
    ]);
    expect(roster?.seatsTaken).toBe(3);
  });

  it("the replacement shows in the student's timetable and opens its lesson, never notes", async () => {
    const week = await loadWeek(
      db,
      { kind: "STUDENT", userId: user.Winner },
      "2026-10-19",
    );
    const target = week.lessons.find((l) => l.id === lessons.bThu);
    expect(target?.attendance?.booking).toMatchObject({
      kind: "replacement",
      bookingId: bookings.winner,
      originalDate: "2026-10-21",
    });
    expect(target?.students).toBeNull();
    const scope = await loadStudentScope(db, user.Winner);
    expect(scope.bookedLessonIds).toEqual([lessons.bThu]);
    const afterStart = local("2026-10-22", "10:05");
    const view = await loadStudentLesson(
      db,
      scope,
      lessons.bThu,
      afterStart,
      TZ,
    );
    expect(view?.id).toBe(lessons.bThu);
    expect(JSON.stringify(view)).not.toContain("SECRET-NOTE-CARM-43");
    expect(JSON.stringify(view)).not.toMatch(/Eve|Finn/);
    // Before it starts, the page is still closed (lessons.md §2).
    expect(
      await loadStudentLesson(db, scope, lessons.bThu, NOW, TZ),
    ).toBeNull();
    // The other student isn't booked onto it.
    const loserScope = await loadStudentScope(db, user.Loser);
    expect(
      await loadStudentLesson(db, loserScope, lessons.bThu, afterStart, TZ),
    ).toBeNull();
  });

  it("refuses another level, someone else's credit and other schools' lessons", async () => {
    await reportAbsence(
      db,
      asStudent("Cara"),
      { lessonId: lessons.aMon, reason: null, expectCredit: true },
      NOW,
    );
    credits.cara2 = (await creditOf(ids.cara, lessons.aMon)).id;
    const result = await bookReplacement(
      db,
      { userId: user.Cara },
      { creditId: credits.cara2, targetLessonId: lessons.cThu },
      NOW,
    );
    expect(result).toMatchObject({
      status: "refused",
      reasons: [{ code: "LEVEL_MISMATCH", level: "B2" }],
    });
    expect(
      await refusal(() =>
        bookReplacement(
          db,
          { userId: user.Eve },
          { creditId: credits.cara2, targetLessonId: lessons.bFri },
          NOW,
        ),
      ),
    ).toBe("common.error.notFound");
    expect(
      await refusal(() =>
        bookReplacement(
          db,
          { userId: user.Cara },
          { creditId: credits.cara2, targetLessonId: lessons.foreign },
          NOW,
        ),
      ),
    ).toBe("common.error.notFound");
    // Teachers have no student profile: not found.
    expect(
      await refusal(() =>
        bookReplacement(
          db,
          { userId: user.Tess },
          { creditId: credits.cara2, targetLessonId: lessons.bFri },
          NOW,
        ),
      ),
    ).toBe("common.error.notFound");
  });

  it("a booking cancelled after its cutoff is STUDENT_LATE and keeps the credit spent", async () => {
    const booked = await bookReplacement(
      db,
      { userId: user.Cara },
      { creditId: credits.cara2, targetLessonId: lessons.bTue },
      NOW,
    );
    expect(booked.status).toBe("booked");
    const id = (booked as { bookingId: string }).bookingId;
    const result = await cancelBooking(db, { userId: user.Cara }, id, NOW);
    expect(result).toMatchObject({ creditBack: false, creditExpired: false });
    expect(
      await client.replacementRequest.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: "CANCELLED",
      cancelReason: "STUDENT_LATE",
      cancelledAt: NOW,
    });
    expect(
      (
        await client.makeupCredit.findUniqueOrThrow({
          where: { id: credits.cara2 },
        })
      ).status,
    ).toBe("USED");
    const roster = await loadLessonRoster(db, lessons.bTue, NOW);
    expect(roster?.notComing).toEqual([
      expect.objectContaining({ name: "Cara", late: true, replacement: true }),
    ]);
    expect(roster?.seatsTaken).toBe(2);
    // Once the lesson has started, cancelling is refused.
    expect(
      await refusal(() =>
        cancelBooking(
          db,
          { userId: user.Cara },
          id,
          local("2026-10-20", "18:00"),
        ),
      ),
    ).toBe("common.error.notFound");
  });

  it("a booking cancelled before its cutoff gives the credit back with its expiry", async () => {
    const before = await client.makeupCredit.findUniqueOrThrow({
      where: { id: credits.loser },
    });
    const result = await cancelBooking(
      db,
      { userId: user.Loser },
      bookings.loser,
      NOW,
    );
    expect(result).toEqual({
      creditBack: true,
      creditExpired: false,
      validUntil: validUntilOf(before.expiresAt, TZ),
    });
    expect(
      await client.makeupCredit.findUniqueOrThrow({
        where: { id: credits.loser },
      }),
    ).toMatchObject({
      status: "AVAILABLE",
      usedAt: null,
      expiresAt: before.expiresAt,
    });
    // Only the student themselves can cancel their booking.
    expect(
      await refusal(() =>
        cancelBooking(db, { userId: user.Eve }, bookings.winner, NOW),
      ),
    ).toBe("common.error.notFound");
  });

  it("admin review: approve, then reject with grace and the access ends", async () => {
    const queue = await listReviewQueue(db, NOW);
    expect(queue.map((r) => r.id)).toEqual([bookings.winner]);
    expect(queue[0]).toMatchObject({ issues: [], seatsTaken: 3 });
    expect(
      await approveReplacements(db, admin(), [bookings.winner], NOW),
    ).toEqual({ status: "done", count: 1 });
    // Approving again: it changed meanwhile.
    expect(
      await approveReplacements(db, admin(), [bookings.winner], NOW),
    ).toEqual({ status: "changed" });
    const result = await rejectReplacement(
      db,
      admin(),
      { bookingId: bookings.winner, note: "Room is needed for an exam." },
      NOW,
    );
    // Valid until 27 Oct (today + 7), later than the credit's 20 Nov? No:
    // the credit's own expiry is later, so it is kept.
    const credit = await client.makeupCredit.findUniqueOrThrow({
      where: { id: credits.winner },
    });
    expect(result).toEqual({
      status: "done",
      validUntil: validUntilOf(credit.expiresAt, TZ),
    });
    expect(credit).toMatchObject({ status: "AVAILABLE", usedAt: null });
    expect(
      await client.replacementRequest.findUniqueOrThrow({
        where: { id: bookings.winner },
      }),
    ).toMatchObject({
      status: "REJECTED",
      reviewedById: user.Admin,
      reviewedAt: NOW,
      reviewNote: "Room is needed for an exam.",
    });
    const audits = await client.auditLog.findMany({
      where: { schoolId, entityId: bookings.winner },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((a) => a.action)).toEqual([
      "replacement.booked",
      "replacement.approved",
      "replacement.rejected",
    ]);
    const scope = await loadStudentScope(db, user.Winner);
    expect(scope.bookedLessonIds).toEqual([]);
    expect(
      await loadStudentLesson(
        db,
        scope,
        lessons.bThu,
        local("2026-10-22", "10:05"),
        TZ,
      ),
    ).toBeNull();
    // The student sees why in History.
    const absences = await loadStudentAbsences(
      db,
      {
        id: user.Winner === user.Cara ? ids.cara : ids.dan,
        userId: user.Winner,
      },
      { shownHistory: 20 },
      NOW,
    );
    expect(absences.history).toContainEqual(
      expect.objectContaining({
        kind: "removedBySchool",
        reason: "Room is needed for an exam.",
      }),
    );
    // Another school's admin can't touch it.
    expect(
      await refusal(() =>
        rejectReplacement(
          otherDb,
          { userId: user.OtherAdmin },
          { bookingId: bookings.winner, note: "x" },
          NOW,
        ),
      ),
    ).toBe("common.error.notFound");
  });

  it("rejecting close to expiry gives at least 7 more days", async () => {
    await client.makeupCredit.update({
      where: { id: credits.winner },
      data: { expiresAt: local("2026-10-24", "00:00") },
    });
    const booked = await bookReplacement(
      db,
      { userId: user.Winner },
      { creditId: credits.winner, targetLessonId: lessons.bThu },
      NOW,
    );
    expect(booked.status).toBe("booked");
    const result = await rejectReplacement(
      db,
      admin(),
      { bookingId: (booked as { bookingId: string }).bookingId, note: "No." },
      NOW,
    );
    expect(result).toEqual({ status: "done", validUntil: "2026-10-27" });
  });

  it("override: keep or move, every overridable reason acknowledged, blocking ones never", async () => {
    const booked = await bookReplacement(
      db,
      { userId: user.Loser },
      { creditId: credits.loser, targetLessonId: lessons.bFri },
      NOW,
    );
    const bookingId = (booked as { bookingId: string }).bookingId;
    // Moving into a B2 lesson needs LEVEL_MISMATCH acknowledged.
    const first = await overrideReplacement(
      db,
      admin(),
      {
        bookingId,
        targetLessonId: lessons.cThu,
        acknowledgedKeys: [],
        note: "Asked for a harder class.",
      },
      NOW,
    );
    expect(first).toMatchObject({
      status: "reasons",
      blocked: false,
      reasons: [{ code: "LEVEL_MISMATCH", key: `LEVEL_MISMATCH:${ids.b2}` }],
    });
    const moved = await overrideReplacement(
      db,
      admin(),
      {
        bookingId,
        targetLessonId: lessons.cThu,
        acknowledgedKeys: [`LEVEL_MISMATCH:${ids.b2}`],
        note: "Asked for a harder class.",
      },
      NOW,
    );
    expect(moved).toEqual({
      status: "done",
      startsAt: local("2026-10-22", "12:00").toISOString(),
    });
    expect(
      await client.replacementRequest.findUniqueOrThrow({
        where: { id: bookingId },
      }),
    ).toMatchObject({
      status: "OVERRIDDEN",
      targetLessonId: lessons.cThu,
      reviewNote: "Asked for a harder class.",
    });
    // Their own group's lesson: ALREADY_ATTENDING blocks even an admin.
    const blocked = await overrideReplacement(
      db,
      admin(),
      {
        bookingId,
        targetLessonId: lessons.aMon,
        acknowledgedKeys: ["ALREADY_ATTENDING"],
        note: "x",
      },
      NOW,
    );
    expect(blocked).toMatchObject({ status: "reasons", blocked: true });
    // Keeping the overridden booking: its LEVEL_MISMATCH is acknowledged again.
    expect(
      await overrideReplacement(
        db,
        admin(),
        {
          bookingId,
          targetLessonId: null,
          acknowledgedKeys: [`LEVEL_MISMATCH:${ids.b2}`],
          note: "Still fine.",
        },
        NOW,
      ),
    ).toMatchObject({ status: "done" });
    bookings.overridden = bookingId;
  });

  it("the school cancelling the target releases the booking with grace", async () => {
    await db.$transaction(async (tx) => {
      await tx.lesson.update({
        where: { id: lessons.cThu },
        data: { status: "CANCELLED", cancelReason: "HOLIDAY" },
      });
      const released = await releaseCancelledLessons(
        tx,
        schoolId,
        [lessons.cThu],
        TZ,
        NOW,
      );
      expect(released).toEqual({ bookings: 1, credits: 0 });
    });
    expect(
      await client.replacementRequest.findUniqueOrThrow({
        where: { id: bookings.overridden },
      }),
    ).toMatchObject({ status: "CANCELLED", cancelReason: "LESSON_CANCELLED" });
    expect(
      await client.makeupCredit.findUniqueOrThrow({
        where: { id: credits.loser },
      }),
    ).toMatchObject({ status: "AVAILABLE", usedAt: null });
  });

  // --- 1-on-1 reschedules ---------------------------------------------------

  let firstMove: string;
  let secondMove: string;

  it("a student reschedules a 1-on-1 before the cutoff: cancelled, credit earned and spent", async () => {
    const sheet = await loadRescheduleSheet(
      db,
      { userId: user.Olga },
      { lessonId: lessons.oThu },
      NOW,
    );
    expect(sheet).toMatchObject({ teacherName: "Tess", again: false });
    expect(sheet.options.length).toBe(20);
    // The usual time (Thursday 16:00) first.
    expect(sheet.options[0]).toMatchObject({
      date: "2026-10-29",
      startMinute: 16 * 60,
      usual: true,
      roomName: "Booth",
    });
    const pick = sheet.options.find((o) => !o.usual)!;
    const result = await rescheduleLesson(
      db,
      { userId: user.Olga },
      { lessonId: lessons.oThu, startsAt: pick.startsAt },
      NOW,
    );
    expect(result.status).toBe("rescheduled");
    firstMove = (result as { lessonId: string }).lessonId;
    const [source, moved, credit] = await Promise.all([
      client.lesson.findUniqueOrThrow({ where: { id: lessons.oThu } }),
      client.lesson.findUniqueOrThrow({ where: { id: firstMove } }),
      creditOf(ids.olga, lessons.oThu),
    ]);
    expect(source).toMatchObject({
      status: "CANCELLED",
      cancelReason: "STUDENT_CANCELLED",
    });
    expect(moved).toMatchObject({
      status: "SCHEDULED",
      timetableSlotId: null,
      occurrenceDate: null,
      rescheduledFromId: lessons.oThu,
      teacherId: ids.tess,
      roomId: ids.oneRoom,
      startsAt: new Date(pick.startsAt),
    });
    expect(moved.endsAt.getTime() - moved.startsAt.getTime()).toBe(45 * 60_000);
    expect(credit).toMatchObject({
      status: "USED",
      rescheduledLessonId: firstMove,
      expiresAt: local("2026-11-22", "00:00"),
    });
    // The teacher's page names who moved it.
    expect(
      (await loadLessonRoster(db, firstMove, NOW))?.rescheduledFrom,
    ).toMatchObject({
      name: "Olga",
      byAdmin: false,
    });
  });

  it("moving it again reuses the same credit and never extends it", async () => {
    const before = await creditOf(ids.olga, lessons.oThu);
    const sheet = await loadRescheduleSheet(
      db,
      { userId: user.Olga },
      { lessonId: firstMove },
      NOW,
    );
    expect(sheet.again).toBe(true);
    const pick = sheet.options.at(-1)!;
    const result = await rescheduleLesson(
      db,
      { userId: user.Olga },
      { lessonId: firstMove, startsAt: pick.startsAt },
      NOW,
    );
    secondMove = (result as { lessonId: string }).lessonId;
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: firstMove } }),
    ).toMatchObject({ status: "CANCELLED" });
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: secondMove } }),
    ).toMatchObject({ rescheduledFromId: firstMove });
    expect(
      await client.makeupCredit.count({ where: { studentId: ids.olga } }),
    ).toBe(1);
    expect(await creditOf(ids.olga, lessons.oThu)).toMatchObject({
      id: before.id,
      status: "USED",
      expiresAt: before.expiresAt,
      rescheduledLessonId: secondMove,
    });
  });

  it("cancelling the rescheduled lesson in time gives the same credit back, no new one", async () => {
    const before = await creditOf(ids.olga, lessons.oThu);
    const result = await reportAbsence(
      db,
      asStudent("Olga"),
      { lessonId: secondMove, reason: null, expectCredit: true },
      NOW,
    );
    expect(result).toMatchObject({
      status: "reported",
      lessonCancelled: true,
      credit: { id: before.id, validUntil: validUntilOf(before.expiresAt, TZ) },
    });
    expect(
      await client.makeupCredit.count({ where: { studentId: ids.olga } }),
    ).toBe(1);
    expect(await creditOf(ids.olga, lessons.oThu)).toMatchObject({
      status: "AVAILABLE",
      expiresAt: before.expiresAt,
      rescheduledLessonId: null,
      usedAt: null,
    });
  });

  it("rescheduling later from the credit continues the chain; a late cancel keeps it spent", async () => {
    const credit = await creditOf(ids.olga, lessons.oThu);
    const sheet = await loadRescheduleSheet(
      db,
      { userId: user.Olga },
      { creditId: credit.id },
      NOW,
    );
    const pick = sheet.options[1];
    const result = await rescheduleLesson(
      db,
      { userId: user.Olga },
      { creditId: credit.id, startsAt: pick.startsAt },
      NOW,
    );
    const lessonId = (result as { lessonId: string }).lessonId;
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: lessonId } }),
    ).toMatchObject({ rescheduledFromId: secondMove });
    // An hour before it starts: after the cutoff.
    const late = new Date(new Date(pick.startsAt).getTime() - 3_600_000);
    const report = await reportAbsence(
      db,
      asStudent("Olga"),
      { lessonId, reason: "Ill", expectCredit: false },
      late,
    );
    expect(report).toMatchObject({ credit: null, lessonCancelled: false });
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: lessonId } }),
    ).toMatchObject({ status: "SCHEDULED" });
    expect(await creditOf(ids.olga, lessons.oThu)).toMatchObject({
      status: "USED",
      rescheduledLessonId: lessonId,
    });
    // An admin cancels it: the credit comes back with grace.
    expect(await cancelRescheduledLesson(db, admin(), lessonId, late)).toEqual({
      creditReleased: true,
    });
    expect(await creditOf(ids.olga, lessons.oThu)).toMatchObject({
      status: "AVAILABLE",
      rescheduledLessonId: null,
    });
  });

  it("after the cutoff only an admin can move a 1-on-1, without minting a credit", async () => {
    expect(
      await refusal(() =>
        loadRescheduleSheet(
          db,
          { userId: user.Olga },
          { lessonId: lessons.oWed },
          NOW,
        ),
      ),
    ).toBe("reschedule.errors.CUTOFF_PASSED");
    const credits = await client.makeupCredit.count({
      where: { studentId: ids.olga },
    });
    // Into Tess's group lesson: blocking, even acknowledged.
    const clash = await rescheduleByAdmin(
      db,
      admin(),
      {
        lessonId: lessons.oWed,
        date: "2026-10-21",
        startMinute: 17 * 60,
        durationMinutes: 45,
        roomId: ids.oneRoom,
        acknowledgedKeys: [],
        note: null,
      },
      NOW,
    );
    expect(clash).toMatchObject({ status: "conflicts", blocking: true });
    if (clash.status !== "conflicts") return;
    expect(clash.conflicts.map((c) => c.type)).toContain(
      "TEACHER_DOUBLE_BOOKED",
    );
    // 21:00 is outside school hours: overridable once acknowledged.
    const input = {
      lessonId: lessons.oWed,
      date: "2026-10-21",
      startMinute: 21 * 60,
      durationMinutes: 60,
      roomId: ids.oneRoom,
      acknowledgedKeys: [] as string[],
      note: "Agreed by phone",
    };
    const ask = await rescheduleByAdmin(db, admin(), input, NOW);
    expect(ask).toMatchObject({ status: "conflicts", blocking: false });
    if (ask.status !== "conflicts") return;
    const done = await rescheduleByAdmin(
      db,
      admin(),
      { ...input, acknowledgedKeys: ask.conflicts.map((c) => c.key) },
      NOW,
    );
    expect(done.status).toBe("rescheduled");
    const lessonId = (done as { lessonId: string }).lessonId;
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: lessons.oWed } }),
    ).toMatchObject({ status: "CANCELLED", cancelReason: "RESCHEDULED" });
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: lessonId } }),
    ).toMatchObject({ rescheduledFromId: lessons.oWed, status: "SCHEDULED" });
    expect(
      await client.makeupCredit.count({ where: { studentId: ids.olga } }),
    ).toBe(credits);
    const audit = await client.auditLog.findFirstOrThrow({
      where: { schoolId, action: "lesson.rescheduled", entityId: lessonId },
    });
    expect(audit.actorId).toBe(user.Admin);
    expect(audit.data).toMatchObject({
      by: "admin",
      note: "Agreed by phone",
      acknowledged: [expect.objectContaining({ type: "OUTSIDE_SCHOOL_HOURS" })],
    });
    // Students and other schools can't use the admin reschedule.
    expect(
      await refusal(() =>
        rescheduleByAdmin(otherDb, { userId: user.OtherAdmin }, input, NOW),
      ),
    ).toBe("common.error.notFound");
  });
});
