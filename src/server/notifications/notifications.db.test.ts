// Notifications against a real Postgres (docs/architecture/phase5-rules.md
// §2, §7). Opt-in, like the other DB tests: set SCHEDULING_TEST_DATABASE_URL
// to a migrated database (never your dev database; the test creates and
// deletes its own schools).

import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { AdminError } from "@/server/admin/result";
import { scopeToSchool } from "@/server/db/school-scope";
import { reportAbsence } from "@/server/replacements/service";
import { fromIsoDate, zonedTimeToUtc } from "@/server/scheduling";
import {
  deleteHoliday,
  publishTerm,
  regenerateLessons,
  saveHoliday,
  saveSlot,
  type SchoolDb,
} from "@/server/timetable/service";

import { listNotifications, markAllRead, markRead, unreadCount } from "./inbox";
import type { LessonFacts } from "./rules";
import { notify } from "./service";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
const TZ = "Europe/Bratislava";
// Term: Monday 2026-10-05 … Sunday 2026-11-29. Now: Tue 20 Oct, 12:00.
const NOW = zonedTimeToUtc("2026-10-20", 12 * 60, TZ);
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe.skipIf(!url)("notifications (database)", () => {
  // Unique per file: the cleanup deletes only this file's users, never
  // those another DB test file is still setting up in parallel.
  const suffix = randomUUID().slice(0, 8);
  let client: PrismaClient;
  let db: SchoolDb;
  let otherDb: SchoolDb;
  let schoolId: string;
  const schools: string[] = [];
  const user: Record<string, string> = {};
  const ids = {
    tess: randomUUID(),
    cara: randomUUID(),
    dan: randomUUID(),
    group: randomUUID(),
    room: randomUUID(),
    term: randomUUID(),
  };
  const actor = () => ({ userId: user.Admin });
  const rows = (where: Record<string, unknown> = {}) =>
    client.notification.findMany({
      where: { schoolId, ...where },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  const viewer = (name: string, role: "ADMIN" | "TEACHER" | "STUDENT") => ({
    userId: user[name],
    role,
  });

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    const school = await client.school.create({
      data: { name: `Notif ${suffix}`, slug: `notif-${suffix}`, timezone: TZ },
    });
    const other = await client.school.create({
      data: { name: `Notif O ${suffix}`, slug: `notif-o-${suffix}` },
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
      user[name] = row.id;
      await client.membership.create({
        data: { schoolId: inSchool, userId: row.id, role },
      });
      return row.id;
    };
    await person("Admin", "ADMIN");
    await person("Admin2", "ADMIN");
    await person("Outsider", "STUDENT", other.id);
    await client.teacherProfile.create({
      data: { id: ids.tess, schoolId, userId: await person("Tess", "TEACHER") },
    });
    await client.studentProfile.createMany({
      data: [
        { id: ids.cara, schoolId, userId: await person("Cara", "STUDENT") },
        { id: ids.dan, schoolId, userId: await person("Dan", "STUDENT") },
      ],
    });
    const level = await client.level.create({
      data: { schoolId, code: "B1", name: "B1", rank: 1 },
    });
    await client.group.create({
      data: {
        id: ids.group,
        schoolId,
        levelId: level.id,
        type: "GROUP",
        name: "B1 Evening",
        capacity: 8,
      },
    });
    await client.groupMembership.createMany({
      data: [
        {
          schoolId,
          groupId: ids.group,
          studentId: ids.cara,
          joinedAt: new Date("2026-09-01"),
        },
        {
          schoolId,
          groupId: ids.group,
          studentId: ids.dan,
          joinedAt: new Date("2026-09-01"),
        },
      ],
    });
    await client.room.create({
      data: {
        id: ids.room,
        schoolId,
        name: "Room 3",
        kind: "PHYSICAL",
        capacity: 8,
      },
    });
    await client.term.create({
      data: {
        id: ids.term,
        schoolId,
        name: "Autumn",
        startDate: fromIsoDate("2026-10-05"),
        endDate: fromIsoDate("2026-11-29"),
      },
    });
    // Thursdays 17:00–18:30.
    const saved = await saveSlot(
      db,
      actor(),
      {
        slot: {
          termId: ids.term,
          groupId: ids.group,
          teacherId: ids.tess,
          roomId: ids.room,
          weekday: 4,
          startMinute: 17 * 60,
          endMinute: 18 * 60 + 30,
        },
      },
      NOW,
    );
    expect(saved.ok).toBe(true);
  });

  afterAll(async () => {
    if (!client) return;
    const where = { where: { schoolId: { in: schools } } };
    await client.makeupCredit.deleteMany(where);
    await client.absenceReport.deleteMany(where);
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

  it("a draft slot notifies nobody", async () => {
    expect(await rows()).toEqual([]);
  });

  it("first publish sends TIMETABLE_PUBLISHED to teachers and students, not the actor", async () => {
    const result = await publishTerm(db, actor(), ids.term, NOW);
    expect(result.ok).toBe(true);
    const all = await rows();
    expect(all.map((r) => [r.recipientId, r.type, r.audience]).sort()).toEqual(
      [
        [user.Cara, "TIMETABLE_PUBLISHED", "student"],
        [user.Dan, "TIMETABLE_PUBLISHED", "student"],
        [user.Tess, "TIMETABLE_PUBLISHED", "teacher"],
      ].sort(),
    );
    const tess = all.find((r) => r.recipientId === user.Tess)!;
    // First lesson from now: Thu 22 Oct 17:00.
    expect(tess.params).toMatchObject({
      term: "Autumn",
      firstStartsAt: zonedTimeToUtc("2026-10-22", 17 * 60, TZ).toISOString(),
    });
    expect(tess.link).toEqual({ kind: "timetable", date: "2026-10-22" });
    const audit = await client.auditLog.findFirstOrThrow({
      where: { schoolId, action: "timetable.published" },
    });
    expect(tess.sourceKey).toBe(
      `${audit.id}:TIMETABLE_PUBLISHED:term:${ids.term}`,
    );
    expect(tess.actorId).toBe(user.Admin);
  });

  it("publishing again changes nothing and notifies nobody", async () => {
    const before = (await rows()).length;
    await publishTerm(db, actor(), ids.term, later(1));
    await regenerateLessons(db, actor(), ids.term, later(2));
    expect((await rows()).length).toBe(before);
  });

  let holidayId: string;

  it("a holiday sends one TIMETABLE_CHANGED per person; repeated, it coalesces while unread", async () => {
    await client.notification.updateMany({
      where: { schoolId },
      data: { readAt: NOW },
    });
    // Thursdays 29 Oct and 5 Nov.
    const saved = await saveHoliday(
      db,
      actor(),
      {
        holiday: {
          termId: ids.term,
          name: "Autumn break",
          startDate: "2026-10-28",
          endDate: "2026-11-06",
        },
      },
      later(3),
    );
    holidayId = saved.holidayId;
    expect(saved.lessons.removed).toBe(2);
    let changed = await rows({ type: "TIMETABLE_CHANGED" });
    expect(changed).toHaveLength(3);
    for (const row of changed) {
      expect(row.params).toMatchObject({
        term: "Autumn",
        added: 0,
        cancelled: 2,
        moved: 0,
        teacherChanged: 0,
        firstDate: "2026-10-29",
        lastDate: "2026-11-05",
      });
      expect(row.coalesceKey).toBe(`term:${ids.term}:changed`);
    }

    // The holiday goes again: the lessons come back. Still one unread row
    // per person, with the counts added up.
    await deleteHoliday(db, actor(), holidayId, later(4));
    changed = await rows({ type: "TIMETABLE_CHANGED" });
    expect(changed).toHaveLength(3);
    expect(changed[0].params).toMatchObject({ added: 2, cancelled: 2 });
    expect(changed[0].createdAt).toEqual(later(4));

    // Run twice: nothing to change, nothing sent (§2.5).
    await regenerateLessons(db, actor(), ids.term, later(5));
    expect(await rows({ type: "TIMETABLE_CHANGED" })).toHaveLength(3);
  });

  it("once read, the next change is a new notification", async () => {
    await markAllRead(
      db,
      viewer("Tess", "TEACHER"),
      `${later(10).toISOString()}|ffffffff-ffff-4fff-bfff-ffffffffffff`,
      later(6),
    );
    await saveHoliday(
      db,
      actor(),
      {
        holiday: {
          termId: ids.term,
          name: "Day off",
          startDate: "2026-11-12",
          endDate: "2026-11-12",
        },
      },
      later(7),
    );
    const tess = await rows({
      recipientId: user.Tess,
      type: "TIMETABLE_CHANGED",
    });
    expect(tess).toHaveLength(2);
    expect(tess[1]).toMatchObject({ readAt: null });
    expect(tess[1].params).toMatchObject({ cancelled: 1, added: 0 });
  });

  it("an expired unread row doesn't absorb a new event (CARM-63 QA)", async () => {
    // Cara's unread TIMETABLE_CHANGED is made 91 days old.
    const cara = await rows({
      recipientId: user.Cara,
      type: "TIMETABLE_CHANGED",
      readAt: null,
    });
    expect(cara).toHaveLength(1);
    await client.notification.update({
      where: { id: cara[0].id },
      data: { createdAt: new Date(later(8).getTime() - 91 * 86_400_000) },
    });
    await saveHoliday(
      db,
      actor(),
      {
        holiday: {
          termId: ids.term,
          name: "Another day off",
          startDate: "2026-11-19",
          endDate: "2026-11-19",
        },
      },
      later(8),
    );
    const fresh = await rows({
      recipientId: user.Cara,
      type: "TIMETABLE_CHANGED",
      readAt: null,
    });
    expect(fresh).toHaveLength(1);
    expect(fresh[0].id).not.toBe(cara[0].id);
    expect(fresh[0].params).toMatchObject({
      cancelled: 1,
      added: 0,
      firstDate: "2026-11-19",
      lastDate: "2026-11-19",
    });
  });

  const facts = async (): Promise<LessonFacts> => {
    const row = await client.lesson.findFirstOrThrow({
      where: { schoolId, startsAt: zonedTimeToUtc("2026-10-22", 17 * 60, TZ) },
    });
    return {
      id: row.id,
      groupName: "B1 Evening",
      lessonType: "GROUP",
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      room: "Room 3",
      teacher: { userId: user.Tess, name: "Tess" },
      substitute: null,
      attendees: [user.Cara, user.Dan],
    };
  };

  it("notifications are written in the caller's transaction and gone after a rollback", async () => {
    const lesson = await facts();
    const before = (await rows()).length;
    await expect(
      db.$transaction(async (tx) => {
        await notify(
          tx,
          { sourceId: randomUUID(), actorId: user.Admin },
          [{ type: "LESSON_CANCELLED", lesson, reason: "SCHOOL_CANCELLED" }],
          NOW,
        );
        expect(await tx.notification.count()).toBe(before + 3);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await rows()).length).toBe(before);
  });

  it("one action emitting the same event twice stores one row per recipient", async () => {
    const lesson = await facts();
    const sourceId = randomUUID();
    await db.$transaction((tx) =>
      notify(
        tx,
        { sourceId, actorId: user.Admin },
        [
          { type: "LESSON_CANCELLED", lesson, reason: "SCHOOL_CANCELLED" },
          { type: "LESSON_CANCELLED", lesson, reason: "SCHOOL_CANCELLED" },
        ],
        NOW,
      ),
    );
    const written = await rows({ sourceKey: { startsWith: sourceId } });
    expect(written.map((r) => r.recipientId).sort()).toEqual(
      [user.Tess, user.Cara, user.Dan].sort(),
    );
    // And recipients outside the school are never written.
    await db.$transaction((tx) =>
      notify(
        tx,
        { sourceId: randomUUID(), actorId: null },
        [{ type: "REPLACEMENT_REVIEW_PENDING", adminIds: [user.Outsider] }],
        NOW,
      ),
    );
    expect(
      await client.notification.count({
        where: { recipientId: user.Outsider },
      }),
    ).toBe(0);
  });

  it("review-pending bookings coalesce into one unread item per admin", async () => {
    for (const i of [1, 2, 3]) {
      await db.$transaction((tx) =>
        notify(
          tx,
          { sourceId: randomUUID(), actorId: user.Cara },
          [
            {
              type: "REPLACEMENT_REVIEW_PENDING",
              adminIds: [user.Admin, user.Admin2],
            },
          ],
          later(20 + i),
        ),
      );
    }
    const pending = await rows({ type: "REPLACEMENT_REVIEW_PENDING" });
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.params)).toEqual([{ count: 3 }, { count: 3 }]);
  });

  it("an absence reported by an admin notifies the teacher and the student, once", async () => {
    const lesson = await facts();
    const report = () =>
      reportAbsence(
        db,
        { userId: user.Admin, role: "ADMIN" },
        { lessonId: lesson.id, studentId: ids.cara, reason: "Ill" },
        NOW,
      );
    await report();
    await expect(report()).rejects.toBeInstanceOf(AdminError);
    const absence = await rows({ type: "ABSENCE_REPORTED" });
    expect(absence.map((r) => [r.recipientId, r.audience]).sort()).toEqual(
      [
        [user.Tess, "teacher"],
        [user.Cara, "student"],
      ].sort(),
    );
    const tess = absence.find((r) => r.audience === "teacher")!;
    expect(tess.params).toMatchObject({ student: "Cara", withCredit: "yes" });
    const cara = absence.find((r) => r.audience === "student")!;
    expect(cara.params).not.toHaveProperty("student");
    // No absence reason is copied (§2.4).
    expect(JSON.stringify(absence)).not.toContain("Ill");
  });

  describe("inbox", () => {
    it("lists own rows newest first with keyset pages", async () => {
      const tess = viewer("Tess", "TEACHER");
      const all = await listNotifications(db, tess, { limit: 50 }, later(30));
      expect(all.items.length).toBeGreaterThanOrEqual(4);
      const first = await listNotifications(db, tess, { limit: 2 }, later(30));
      expect(first.items.map((i) => i.id)).toEqual(
        all.items.slice(0, 2).map((i) => i.id),
      );
      const second = await listNotifications(
        db,
        tess,
        { limit: 2, cursor: first.nextCursor },
        later(30),
      );
      expect(second.items.map((i) => i.id)).toEqual(
        all.items.slice(2, 4).map((i) => i.id),
      );
      const times = all.items.map((i) => i.createdAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it("resolves links per role: teacher lesson page, student timetable week before the start", async () => {
      const lesson = await facts();
      const tessItems = await listNotifications(
        db,
        viewer("Tess", "TEACHER"),
        { limit: 50 },
        later(30),
      );
      const absence = tessItems.items.find(
        (i) => i.type === "ABSENCE_REPORTED",
      )!;
      expect(absence.href).toBe(`/teacher/lessons/${lesson.id}`);
      const cancelled = (
        await listNotifications(
          db,
          viewer("Dan", "STUDENT"),
          { limit: 50 },
          later(30),
        )
      ).items.find((i) => i.type === "LESSON_CANCELLED")!;
      expect(cancelled.href).toBe("/student/timetable?week=2026-10-22");
      // Dan leaves the group: the lesson is no longer his to open.
      await client.groupMembership.updateMany({
        where: { studentId: ids.dan },
        data: { leftAt: new Date("2026-10-01") },
      });
      const gone = (
        await listNotifications(
          db,
          viewer("Dan", "STUDENT"),
          { limit: 50 },
          later(30),
        )
      ).items.find((i) => i.type === "LESSON_CANCELLED")!;
      expect(gone.href).toBeNull();
      const review = (
        await listNotifications(
          db,
          viewer("Admin2", "ADMIN"),
          { limit: 50 },
          later(30),
        )
      ).items[0];
      expect(review.href).toBe("/admin/absences?tab=review");
    });

    it("unread count, mark read (own rows only) and mark all read up to a row", async () => {
      const cara = viewer("Cara", "STUDENT");
      const unread = await unreadCount(db, cara, later(30));
      expect(unread).toBeGreaterThan(0);
      const page = await listNotifications(
        db,
        cara,
        { limit: 50, unreadOnly: true },
        later(30),
      );
      expect(page.items).toHaveLength(unread);

      // Someone else's id, another school's client, a malformed id: not found.
      const id = page.items[0].id;
      expect(
        await markRead(db, viewer("Dan", "STUDENT"), id, later(30)),
      ).toBeNull();
      expect(await markRead(otherDb, cara, id, later(30))).toBeNull();
      expect(await markRead(db, cara, "nope", later(30))).toBeNull();

      const opened = await markRead(db, cara, id, later(30));
      expect(opened).not.toBeNull();
      // Idempotent: the first readAt stays.
      await markRead(db, cara, id, later(40));
      const row = await client.notification.findUniqueOrThrow({
        where: { id },
      });
      expect(row.readAt).toEqual(later(30));
      expect(await unreadCount(db, cara, later(30))).toBe(unread - 1);

      // A new notification arrives after the client rendered the list.
      const shown = await listNotifications(db, cara, { limit: 50 }, later(30));
      await db.$transaction(async (tx) =>
        notify(
          tx,
          { sourceId: randomUUID(), actorId: user.Admin },
          [
            {
              type: "LESSON_CANCELLED",
              lesson: await facts(),
              reason: "SCHOOL_CANCELLED",
            },
          ],
          later(31),
        ),
      );
      const { encodeCursor } = await import("./inbox");
      await markAllRead(db, cara, encodeCursor(shown.items[0]), later(32));
      expect(await unreadCount(db, cara, later(32))).toBe(1);
    });

    it("hides and purges rows older than 90 days", async () => {
      const dan = viewer("Dan", "STUDENT");
      const [oldest] = await rows({ recipientId: user.Dan });
      await client.notification.update({
        where: { id: oldest.id },
        data: {
          createdAt: new Date(NOW.getTime() - 90 * 86_400_000),
          readAt: null,
        },
      });
      const unread = await unreadCount(db, dan, NOW);
      const page = await listNotifications(db, dan, { limit: 50 }, NOW);
      expect(page.items.map((i) => i.id)).not.toContain(oldest.id);
      expect(
        await client.notification.findUnique({ where: { id: oldest.id } }),
      ).toBeNull();
      expect(await unreadCount(db, dan, NOW)).toBe(unread);
    });
  });
});
