// Integration tests of the timetable service against a real Postgres.
// Opt-in: set SCHEDULING_TEST_DATABASE_URL to a migrated database (never your
// dev database; the tests create and delete their own school), e.g.
//   SCHEDULING_TEST_DATABASE_URL=postgresql://…/schoolmanager_test pnpm test
// Optional: if the demo school is seeded there, its timetable is checked too.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { createPgAdapter } from "@/lib/pg-adapter";
import { scopeToSchool } from "@/server/db/school-scope";
import { fromIsoDate, toIsoDate } from "@/server/scheduling";

import {
  checkTerm,
  deleteHoliday,
  deleteSlot,
  deleteTerm,
  endSlot,
  publishTerm,
  saveHoliday,
  saveSlot,
  type SchoolDb,
  SchedulingError,
  type SlotInput,
  timetableLockKey,
  validateSlot,
} from "./service";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;

// Term: Monday 2026-10-05 … Sunday 2026-11-29. "Now" is mid-term.
const TERM_START = "2026-10-05";
const TERM_END = "2026-11-29";
const NOW = new Date("2026-10-20T10:00:00Z"); // Tuesday, 12:00 in Bratislava

describe.skipIf(!url)("timetable service (database)", () => {
  // Unique per file: the cleanup deletes only this file's users, never
  // those another DB test file is still setting up in parallel.
  const suffix = randomUUID().slice(0, 8);
  let client: PrismaClient;
  let db: SchoolDb;
  let actor: { userId: string };
  let schoolId: string;
  const ids = {
    term: randomUUID(),
    draftTerm: randomUUID(),
    teacherA: randomUUID(),
    teacherB: randomUUID(),
    group: randomUUID(),
    group2: randomUUID(),
    room: randomUUID(),
    smallRoom: randomUUID(),
    student: randomUUID(),
  };
  const slotInput = (extra: Partial<SlotInput> = {}): SlotInput => ({
    termId: ids.term,
    groupId: ids.group,
    teacherId: ids.teacherA,
    roomId: ids.room,
    weekday: 1,
    startMinute: 9 * 60,
    endMinute: 10 * 60 + 30,
    ...extra,
  });
  const lessonsOf = (slotId: string) =>
    client.lesson.findMany({
      where: { timetableSlotId: slotId },
      orderBy: { occurrenceDate: "asc" },
    });
  const dates = (lessons: { occurrenceDate: Date | null }[]) =>
    lessons.map((l) => toIsoDate(l.occurrenceDate!));

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: createPgAdapter(url),
    });
    const school = await client.school.create({
      data: { name: `Scheduling test ${suffix}`, slug: `sched-test-${suffix}` },
    });
    schoolId = school.id;
    db = scopeToSchool(client, schoolId);

    const user = (name: string) =>
      client.user.create({
        data: { name, email: `${name.toLowerCase()}-${suffix}@example.test` },
      });
    const admin = await user("Admin");
    actor = { userId: admin.id };
    const [ua, ub, us] = [
      await user("Anna"),
      await user("Ben"),
      await user("Sara"),
    ];
    await client.membership.createMany({
      data: [
        { schoolId, userId: admin.id, role: "ADMIN" },
        { schoolId, userId: ua.id, role: "TEACHER" },
        { schoolId, userId: ub.id, role: "TEACHER" },
        { schoolId, userId: us.id, role: "STUDENT" },
      ],
    });
    await client.teacherProfile.createMany({
      data: [
        { id: ids.teacherA, schoolId, userId: ua.id },
        { id: ids.teacherB, schoolId, userId: ub.id },
      ],
    });
    await client.studentProfile.create({
      data: { id: ids.student, schoolId, userId: us.id },
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
          name: "G1",
          capacity: 8,
        },
        {
          id: ids.group2,
          schoolId,
          levelId: level.id,
          type: "GROUP",
          name: "G2",
          capacity: 8,
        },
      ],
    });
    await client.groupMembership.createMany({
      data: [
        { schoolId, groupId: ids.group, studentId: ids.student },
        { schoolId, groupId: ids.group2, studentId: ids.student },
      ],
    });
    await client.room.createMany({
      data: [
        { id: ids.room, schoolId, name: "Room", kind: "PHYSICAL", capacity: 8 },
        {
          id: ids.smallRoom,
          schoolId,
          name: "Closet",
          kind: "PHYSICAL",
          capacity: 1,
        },
      ],
    });
    await client.term.createMany({
      data: [
        {
          id: ids.term,
          schoolId,
          name: "Term",
          startDate: fromIsoDate(TERM_START),
          endDate: fromIsoDate(TERM_END),
        },
        {
          id: ids.draftTerm,
          schoolId,
          name: "Next term",
          startDate: fromIsoDate("2027-02-01"),
          endDate: fromIsoDate("2027-03-31"),
        },
      ],
    });
  });

  afterAll(async () => {
    if (!client) return;
    // Lessons restrict term deletion, so remove them before the school.
    await client.lesson.deleteMany({ where: { schoolId } });
    await client.school.delete({ where: { id: schoolId } });
    await client.user.deleteMany({
      where: {
        email: { endsWith: `-${suffix}@example.test` },
        memberships: { none: {} },
      },
    });
    await client.$disconnect();
  });

  let mondaySlot: string;

  it("saves a draft slot without lessons", async () => {
    const result = await saveSlot(db, actor, { slot: slotInput() }, NOW);
    expect(result).toMatchObject({ ok: true, lessons: { created: 0 } });
    mondaySlot = (result as { slotId: string }).slotId;
    // Draft term: the slot covers the whole term.
    const row = await client.timetableSlot.findUniqueOrThrow({
      where: { id: mondaySlot },
    });
    expect(row.validFrom).toBeNull();
  });

  it("refuses a teacher double-booking", async () => {
    const result = await saveSlot(
      db,
      actor,
      {
        slot: slotInput({
          groupId: ids.group2,
          roomId: null,
          startMinute: 600,
          endMinute: 690,
        }),
      },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, reason: "BLOCKING_CONFLICTS" });
  });

  it("needs an acknowledged override for overridable conflicts and audits it", async () => {
    const request = {
      slot: slotInput({
        groupId: ids.group2,
        teacherId: ids.teacherB,
        roomId: ids.smallRoom,
        weekday: 7, // Sunday: outside the school week
      }),
    };
    const conflicts = await validateSlot(db, request, NOW);
    expect(conflicts.map((c) => c.type)).toEqual(["OUTSIDE_SCHOOL_DAYS"]);
    expect(await saveSlot(db, actor, request, NOW)).toMatchObject({
      ok: false,
      reason: "UNACKNOWLEDGED_CONFLICTS",
    });
    const saved = await saveSlot(
      db,
      actor,
      {
        ...request,
        acknowledgedConflictKeys: conflicts.map((c) => c.key),
        reason: "Weekend intensive",
      },
      NOW,
    );
    expect(saved.ok).toBe(true);
    const log = await client.auditLog.findFirstOrThrow({
      where: {
        schoolId,
        action: "timetable_slot.created",
        entityId: (saved as { slotId: string }).slotId,
      },
    });
    expect(log.actorId).toBe(actor.userId);
    expect(log.data).toMatchObject({
      overridden: [{ type: "OUTSIDE_SCHOOL_DAYS", key: conflicts[0].key }],
      reason: "Weekend intensive",
    });
    await deleteSlot(db, actor, (saved as { slotId: string }).slotId, NOW);
  });

  it("audits no override reason when nothing was overridden", async () => {
    const saved = await saveSlot(
      db,
      actor,
      {
        slot: slotInput({
          groupId: ids.group2,
          teacherId: ids.teacherB,
          roomId: null,
          weekday: 3,
        }),
        reason: "Not an override",
      },
      NOW,
    );
    expect(saved).toMatchObject({ ok: true, overridden: [] });
    const slotId = (saved as { slotId: string }).slotId;
    const log = await client.auditLog.findFirstOrThrow({
      where: { schoolId, action: "timetable_slot.created", entityId: slotId },
    });
    expect(log.data).not.toHaveProperty("reason");
    await deleteSlot(db, actor, slotId, NOW);
  });

  it("publishes and generates lessons from today on, idempotently", async () => {
    const first = await publishTerm(db, actor, ids.term, NOW);
    // Mondays from 2026-10-26 (today is Tuesday 2026-10-20) to 2026-11-23.
    expect(first).toMatchObject({ ok: true, lessons: { created: 5 } });
    expect(dates(await lessonsOf(mondaySlot))).toEqual([
      "2026-10-26",
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
      "2026-11-23",
    ]);
    expect(await publishTerm(db, actor, ids.term, NOW)).toMatchObject({
      ok: true,
      lessons: { created: 0, removed: 0, cancelled: 0 },
    });
  });

  it("splits a slot edited mid-term; earlier lessons keep the old template", async () => {
    // A week later: the 2026-10-26 lesson has taken place.
    const later = new Date("2026-10-27T10:00:00Z");
    const result = await saveSlot(
      db,
      actor,
      {
        slotId: mondaySlot,
        slot: slotInput({ weekday: 2 }),
        effectiveFrom: "2026-11-01",
      },
      later,
    );
    expect(result).toMatchObject({ ok: true, endedSlotId: mondaySlot });
    const tuesdaySlot = (result as { slotId: string }).slotId;
    expect(dates(await lessonsOf(mondaySlot))).toEqual(["2026-10-26"]);
    expect(dates(await lessonsOf(tuesdaySlot))).toEqual([
      "2026-11-03",
      "2026-11-10",
      "2026-11-17",
      "2026-11-24",
    ]);
    const ended = await client.timetableSlot.findUniqueOrThrow({
      where: { id: mondaySlot },
    });
    expect(toIsoDate(ended.validUntil!)).toBe("2026-10-31");
    mondaySlot = tuesdaySlot;
  });

  it("refuses changes that start in the past", async () => {
    await expect(
      saveSlot(
        db,
        actor,
        {
          slotId: mondaySlot,
          slot: slotInput({ weekday: 2 }),
          effectiveFrom: "2026-10-01",
        },
        NOW,
      ),
    ).rejects.toThrow(SchedulingError);
  });

  it("removes lessons on a new holiday and restores them when it is deleted", async () => {
    const { holidayId, lessons } = await saveHoliday(
      db,
      actor,
      {
        holiday: {
          termId: null,
          name: "Snow",
          startDate: "2026-11-10",
          endDate: "2026-11-10",
        },
      },
      NOW,
    );
    expect(lessons).toEqual({ created: 0, removed: 1, cancelled: 0 });
    expect(dates(await lessonsOf(mondaySlot))).not.toContain("2026-11-10");
    expect(await deleteHoliday(db, actor, holidayId, NOW)).toEqual({
      created: 1,
      removed: 0,
      cancelled: 0,
    });
  });

  it("ends a slot: deletes untouched future lessons, cancels ones with history", async () => {
    const lessons = await lessonsOf(mondaySlot);
    const withAbsence = lessons.find(
      (l) => toIsoDate(l.occurrenceDate!) === "2026-11-24",
    )!;
    await client.absenceReport.create({
      data: { schoolId, lessonId: withAbsence.id, studentId: ids.student },
    });
    const result = await endSlot(
      db,
      actor,
      { slotId: mondaySlot, lastDate: "2026-11-10" },
      NOW,
    );
    expect(result).toEqual({
      outcome: "ended",
      lastDate: "2026-11-10",
      lessons: { created: 0, removed: 1, cancelled: 1 },
    });
    const after = await lessonsOf(mondaySlot);
    expect(
      after.map((l) => [
        toIsoDate(l.occurrenceDate!),
        l.status,
        l.cancelReason,
      ]),
    ).toEqual([
      ["2026-11-03", "SCHEDULED", null],
      ["2026-11-10", "SCHEDULED", null],
      ["2026-11-24", "CANCELLED", "TIMETABLE_CHANGED"],
    ]);
  });

  it("keeps slots in an archived room but refuses new ones there", async () => {
    await client.room.update({
      where: { id: ids.room },
      data: { archivedAt: NOW },
    });
    try {
      // mondaySlot (now on Tuesdays) is in the archived room.
      expect(await publishTerm(db, actor, ids.term, NOW)).toMatchObject({
        ok: true,
      });
      const kept = await validateSlot(
        db,
        { slotId: mondaySlot, slot: slotInput({ weekday: 2 }) },
        NOW,
      );
      expect(kept.map((c) => c.type)).not.toContain("ROOM_ARCHIVED");
      const result = await saveSlot(
        db,
        actor,
        { slot: slotInput({ termId: ids.draftTerm, weekday: 3 }) },
        NOW,
      );
      expect(result).toMatchObject({
        ok: false,
        reason: "BLOCKING_CONFLICTS",
        conflicts: [{ type: "ROOM_ARCHIVED", params: { room: "Room" } }],
      });
    } finally {
      await client.room.update({
        where: { id: ids.room },
        data: { archivedAt: null },
      });
    }
  });

  it("waits for the per-school timetable lock", async () => {
    let acquired!: () => void;
    let release!: () => void;
    const isAcquired = new Promise<void>((resolve) => (acquired = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${timetableLockKey(schoolId)}, 0))`;
        acquired();
        await released;
      },
      { timeout: 10_000 },
    );
    await isAcquired;
    let finished = false;
    const save = saveSlot(
      db,
      actor,
      { slot: slotInput({ termId: ids.draftTerm, weekday: 6 }) },
      NOW,
    ).then((result) => {
      finished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toBe(false);
    release();
    await holder;
    expect((await save).ok).toBe(true);
  });

  it("lets only one of two concurrent double-bookings win", async () => {
    const request = {
      slot: slotInput({ termId: ids.draftTerm, weekday: 4, roomId: null }),
    };
    const results = await Promise.all([
      saveSlot(db, actor, request, NOW),
      saveSlot(
        db,
        actor,
        { slot: { ...request.slot, groupId: ids.group2 } },
        NOW,
      ),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({
      reason: "BLOCKING_CONFLICTS",
    });
  });

  it("deletes a draft term with its slots and holidays, but not a term with lessons", async () => {
    await saveHoliday(
      db,
      actor,
      {
        holiday: {
          termId: ids.draftTerm,
          name: "Break",
          startDate: "2027-02-15",
          endDate: "2027-02-16",
        },
      },
      NOW,
    );
    await expect(deleteTerm(db, actor, ids.term)).rejects.toMatchObject({
      code: "TERM_HAS_LESSONS",
    });
    await deleteTerm(db, actor, ids.draftTerm);
    expect(
      await client.holiday.count({ where: { termId: ids.draftTerm } }),
    ).toBe(0);
    expect(
      await client.timetableSlot.count({ where: { termId: ids.draftTerm } }),
    ).toBe(0);
  });

  it("finds no blocking conflicts in the seeded demo timetable", async () => {
    const demo = await client.school.findUnique({
      where: { slug: "demo-language-school" },
    });
    if (!demo) return;
    const term = await client.term.findFirstOrThrow({
      where: { schoolId: demo.id },
    });
    const result = await checkTerm(
      scopeToSchool(client, demo.id),
      term.id,
      NOW,
    );
    const blocking = [...result.values()]
      .flat()
      .filter((c) => c.severity === "blocking");
    expect(blocking).toEqual([]);
  });
});
