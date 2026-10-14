// Integration tests of the generator service against a real Postgres
// (docs/architecture/generator.md §6.3, DB tests). Opt-in like the other
// *.db.test.ts: set SCHEDULING_TEST_DATABASE_URL to a migrated database
// (never your dev database; the tests create and delete their own schools).

import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { scopeToSchool } from "@/server/db/school-scope";
import { fromIsoDate, toIsoDate } from "@/server/scheduling";

import {
  type ApplyIssue,
  applyDraft,
  cancelRun,
  checkDraft,
  checkReadiness,
  discardDraft,
  executeRun,
  GeneratorError,
  getDraft,
  getRun,
  previewApply,
  saveAssignment,
  setAssignmentsLocked,
  setGroupSkipped,
  STALE_RUN_MS,
  startRun,
  teacherOptions,
} from "./generator-service";
import { publishTerm, type SchoolDb, SchedulingError } from "./service";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;

// "Now" is Tuesday 2026-10-20, 12:00 in Bratislava. The published term runs
// Monday 2026-10-05 … Sunday 2026-11-29; the default effective date is the
// next Monday, 2026-10-26. The draft term is in 2027.
const NOW = new Date("2026-10-20T10:00:00Z");
const D = "2026-10-26";
const PUBLISHED = { start: "2026-10-05", end: "2026-11-29" };
const DRAFT_TERM = { start: "2027-02-01", end: "2027-03-28" };

const later = (ms: number) => new Date(NOW.getTime() + ms);

async function rejects(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      (error instanceof GeneratorError || error instanceof SchedulingError) &&
      error.code === code,
  );
}

describe.skipIf(!url)("generator service (database)", () => {
  let client: PrismaClient;
  let db: SchoolDb;
  let otherDb: SchoolDb;
  let actor: { userId: string };
  let schoolId: string;
  let otherSchoolId: string;
  const ids = {
    published: randomUUID(),
    draftTerm: randomUUID(),
    b1: randomUUID(),
    a1: randomUUID(),
    anna: randomUUID(), // B1 + A1
    ben: randomUUID(), // B1
    cleo: randomUUID(), // A1
    dora: randomUUID(), // B1, joins later
    g1: randomUUID(), // B1, Mon 09:00–10:30
    g2: randomUUID(), // B1, Mon 09:00–10:30 in the small room
    g3: randomUUID(), // A1 1-on-1, Wed 15:00–16:00
    room: randomUUID(),
    closet: randomUUID(),
    s1: randomUUID(),
    s2: randomUUID(),
    s3: randomUUID(),
    s4: randomUUID(),
  };
  const userIds: Record<string, string> = {};

  const runToEnd = async (request: Parameters<typeof startRun>[2]) => {
    const { runId, draftId } = await startRun(db, actor, request, NOW);
    const status = await executeRun(db, runId, { now: () => NOW });
    return { runId, draftId, status };
  };
  const assignmentsOf = async (draftId: string) =>
    Object.fromEntries(
      (
        await client.timetableDraftAssignment.findMany({ where: { draftId } })
      ).map((a) => [a.groupId, a]),
    );
  const keys = (issues: ApplyIssue[]) => issues.map((i) => i.key);

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    const suffix = randomUUID().slice(0, 8);
    const school = await client.school.create({
      data: { name: `Generator test ${suffix}`, slug: `gen-test-${suffix}` },
    });
    schoolId = school.id;
    db = scopeToSchool(client, schoolId);
    const other = await client.school.create({
      data: { name: `Generator other ${suffix}`, slug: `gen-other-${suffix}` },
    });
    otherSchoolId = other.id;
    otherDb = scopeToSchool(client, otherSchoolId);

    const user = async (
      name: string,
      role: "ADMIN" | "TEACHER" | "STUDENT",
    ) => {
      const u = await client.user.create({
        data: { name, email: `${name.toLowerCase()}-${suffix}@example.test` },
      });
      await client.membership.create({
        data: { schoolId, userId: u.id, role },
      });
      userIds[name] = u.id;
      return u;
    };
    actor = { userId: (await user("Admin", "ADMIN")).id };
    for (const [name, id] of [
      ["Anna", ids.anna],
      ["Ben", ids.ben],
      ["Cleo", ids.cleo],
      ["Dora", ids.dora],
    ] as const) {
      const u = await user(name, "TEACHER");
      await client.teacherProfile.create({
        data: { id, schoolId, userId: u.id },
      });
    }
    for (const [name, id] of [
      ["S1", ids.s1],
      ["S2", ids.s2],
      ["S3", ids.s3],
      ["S4", ids.s4],
    ] as const) {
      const u = await user(name, "STUDENT");
      await client.studentProfile.create({
        data: { id, schoolId, userId: u.id },
      });
    }
    await client.level.createMany({
      data: [
        { id: ids.a1, schoolId, code: "A1", name: "A1", rank: 1 },
        { id: ids.b1, schoolId, code: "B1", name: "B1", rank: 3 },
      ],
    });
    await client.teacherLevel.createMany({
      data: [
        { schoolId, teacherId: ids.anna, levelId: ids.b1 },
        { schoolId, teacherId: ids.anna, levelId: ids.a1 },
        { schoolId, teacherId: ids.ben, levelId: ids.b1 },
        { schoolId, teacherId: ids.cleo, levelId: ids.a1 },
      ],
    });
    await client.room.createMany({
      data: [
        { id: ids.room, schoolId, name: "Room", kind: "PHYSICAL", capacity: 8 },
        {
          id: ids.closet,
          schoolId,
          name: "Closet",
          kind: "PHYSICAL",
          capacity: 1,
        },
      ],
    });
    await client.group.createMany({
      data: [
        {
          id: ids.g1,
          schoolId,
          levelId: ids.b1,
          type: "GROUP",
          name: "G1",
          capacity: 8,
        },
        {
          id: ids.g2,
          schoolId,
          levelId: ids.b1,
          type: "GROUP",
          name: "G2",
          capacity: 8,
        },
        {
          id: ids.g3,
          schoolId,
          levelId: ids.a1,
          type: "ONE_ON_ONE",
          name: "G3",
          capacity: 1,
        },
      ],
    });
    await client.groupMembership.createMany({
      data: [
        { schoolId, groupId: ids.g1, studentId: ids.s1 },
        { schoolId, groupId: ids.g2, studentId: ids.s2 },
        { schoolId, groupId: ids.g2, studentId: ids.s3 },
        { schoolId, groupId: ids.g3, studentId: ids.s4 },
      ],
    });
    await client.groupLessonTime.createMany({
      data: [
        {
          schoolId,
          groupId: ids.g1,
          weekday: 1,
          startMinute: 540,
          endMinute: 630,
          roomId: ids.room,
        },
        {
          schoolId,
          groupId: ids.g2,
          weekday: 1,
          startMinute: 540,
          endMinute: 630,
          roomId: ids.closet,
        },
        {
          schoolId,
          groupId: ids.g3,
          weekday: 3,
          startMinute: 900,
          endMinute: 960,
          roomId: ids.room,
        },
      ],
    });
    await client.term.createMany({
      data: [
        {
          id: ids.published,
          schoolId,
          name: "Autumn",
          startDate: fromIsoDate(PUBLISHED.start),
          endDate: fromIsoDate(PUBLISHED.end),
        },
        {
          id: ids.draftTerm,
          schoolId,
          name: "Spring",
          startDate: fromIsoDate(DRAFT_TERM.start),
          endDate: fromIsoDate(DRAFT_TERM.end),
        },
      ],
    });
    // The published term: G1 and G3 with Anna; G2 is new and has no slot.
    await client.timetableSlot.createMany({
      data: [
        {
          schoolId,
          termId: ids.published,
          groupId: ids.g1,
          teacherId: ids.anna,
          roomId: ids.room,
          weekday: 1,
          startMinute: 540,
          endMinute: 630,
        },
        {
          schoolId,
          termId: ids.published,
          groupId: ids.g3,
          teacherId: ids.anna,
          roomId: ids.room,
          weekday: 3,
          startMinute: 900,
          endMinute: 960,
        },
      ],
    });
    const published = await publishTerm(db, actor, ids.published, NOW);
    expect(published.ok).toBe(true);
  });

  afterAll(async () => {
    if (!client) return;
    for (const id of [schoolId, otherSchoolId]) {
      if (!id) continue;
      await client.timetableDraft.deleteMany({ where: { schoolId: id } });
      await client.replacementRequest.deleteMany({ where: { schoolId: id } });
      await client.makeupCredit.deleteMany({ where: { schoolId: id } });
      await client.absenceReport.deleteMany({ where: { schoolId: id } });
      await client.lesson.deleteMany({ where: { schoolId: id } });
      await client.school.delete({ where: { id } });
    }
    await client.user.deleteMany({
      where: { id: { in: Object.values(userIds) } },
    });
    await client.$disconnect();
  });

  describe("unpublished term: REPLACE", () => {
    let draftId: string;

    it("classifies groups and honours skip flags", async () => {
      const ready = await checkReadiness(db, ids.draftTerm, {}, NOW);
      expect(ready.mode).toBe("REPLACE");
      expect(ready.groups.map((g) => g.status)).toEqual([
        "READY",
        "READY",
        "READY",
      ]);
      await setGroupSkipped(db, actor, {
        termId: ids.draftTerm,
        groupId: ids.g3,
        skipped: true,
      });
      const skipped = await checkReadiness(db, ids.draftTerm, {}, NOW);
      expect(skipped.groups.find((g) => g.groupId === ids.g3)!.status).toBe(
        "SKIPPED",
      );
      await setGroupSkipped(db, actor, {
        termId: ids.draftTerm,
        groupId: ids.g3,
        skipped: false,
      });
      expect(await client.groupTermSkip.count({ where: { schoolId } })).toBe(0);
    });

    it("imports the editor's teachers, locked, and runs once at a time", async () => {
      // The editor already has G3 with Anna in the draft term.
      await client.timetableSlot.create({
        data: {
          schoolId,
          termId: ids.draftTerm,
          groupId: ids.g3,
          teacherId: ids.anna,
          roomId: ids.room,
          weekday: 3,
          startMinute: 900,
          endMinute: 960,
        },
      });
      const started = await startRun(
        db,
        actor,
        { termId: ids.draftTerm, mode: "REPLACE" },
        NOW,
      );
      draftId = started.draftId;
      expect(await assignmentsOf(draftId)).toMatchObject({
        [ids.g3]: { teacherId: ids.anna, locked: true, origin: "IMPORTED" },
      });
      await rejects(
        startRun(db, actor, { termId: ids.draftTerm, mode: "REPLACE" }, NOW),
        "RUN_IN_PROGRESS",
      );
      const draft = await getDraft(db, ids.draftTerm, NOW);
      await rejects(
        saveAssignment(
          db,
          {
            draftId,
            version: draft!.version,
            groupId: ids.g3,
            teacherId: null,
          },
          NOW,
        ),
        "RUN_IN_PROGRESS",
      );
      await rejects(discardDraft(db, actor, draftId, NOW), "RUN_IN_PROGRESS");

      expect(await executeRun(db, started.runId, { now: () => NOW })).toBe(
        "DONE",
      );
      const run = await getRun(db, started.runId, NOW);
      expect(run).toMatchObject({
        status: "DONE",
        result: { assigned: 3, unassigned: 0, stoppedBy: "converged" },
      });
      const assignments = await assignmentsOf(draftId);
      // G1 and G2 run at the same time: Anna and Ben take one each.
      expect(
        [assignments[ids.g1].teacherId, assignments[ids.g2].teacherId].sort(),
      ).toEqual([ids.anna, ids.ben].sort());
      expect(assignments[ids.g3]).toMatchObject({
        teacherId: ids.anna,
        locked: true,
      });
      const view = await getDraft(db, ids.draftTerm, NOW);
      expect(view).toMatchObject({ outOfDate: false, mode: "REPLACE" });
      expect(
        await client.auditLog.count({
          where: { schoolId, action: "generator_run.finished" },
        }),
      ).toBe(1);
    });

    it("refuses busy picks and stale versions; locks manual picks", async () => {
      const view = (await getDraft(db, ids.draftTerm, NOW))!;
      const options = await teacherOptions(
        db,
        { draftId, groupId: ids.g1 },
        NOW,
      );
      const g2Teacher = view.assignments.find(
        (a) => a.groupId === ids.g2,
      )!.teacherId!;
      expect(options.find((o) => o.teacherId === g2Teacher)!.section).toBe(
        "BUSY",
      );
      expect(options.find((o) => o.teacherId === ids.cleo)!.section).toBe(
        "NOT_TEACHING_LEVEL",
      );
      const busy = await saveAssignment(
        db,
        {
          draftId,
          version: view.version,
          groupId: ids.g1,
          teacherId: g2Teacher,
        },
        NOW,
      );
      expect(busy).toMatchObject({ ok: false, reason: "BLOCKING_CONFLICTS" });

      const saved = await saveAssignment(
        db,
        {
          draftId,
          version: view.version,
          groupId: ids.g3,
          teacherId: ids.cleo,
        },
        NOW,
      );
      expect(saved.ok).toBe(true);
      const after = (saved as { draft: { version: number } }).draft;
      expect(after.version).toBe(view.version + 1);
      expect((await assignmentsOf(draftId))[ids.g3]).toMatchObject({
        teacherId: ids.cleo,
        locked: true,
        origin: "MANUAL",
      });

      const stale = await setAssignmentsLocked(
        db,
        { draftId, version: view.version, groupIds: [ids.g1], locked: true },
        NOW,
      );
      expect(stale).toMatchObject({
        ok: false,
        reason: "DRAFT_CHANGED",
        draft: { version: after.version },
      });
      const locked = await setAssignmentsLocked(
        db,
        { draftId, version: after.version, groupIds: [ids.g1], locked: true },
        NOW,
      );
      expect(locked.ok).toBe(true);
      expect((await assignmentsOf(draftId))[ids.g1].locked).toBe(true);
    });

    it("goes out of date when data changes, and Check draft re-checks", async () => {
      await client.teacherProfile.update({
        where: { id: ids.ben },
        data: { maxMinutesPerWeek: 60 },
      });
      const view = (await getDraft(db, ids.draftTerm, NOW))!;
      expect(view.outOfDate).toBe(true);
      const checked = await checkDraft(db, { draftId }, NOW);
      const benHasGroup = checked.assignments.some(
        (a) => a.teacherId === ids.ben,
      );
      expect(benHasGroup).toBe(true);
      expect(
        (checked.warnings as { teachers: { teacherId: string }[] }).teachers,
      ).toEqual([expect.objectContaining({ teacherId: ids.ben })]);
      await client.teacherProfile.update({
        where: { id: ids.ben },
        data: { maxMinutesPerWeek: null },
      });
    });

    it("refuses archived teachers and unacknowledged warnings", async () => {
      await client.user.update({
        where: { id: userIds.Cleo },
        data: { deletedAt: NOW },
      });
      const view = (await getDraft(db, ids.draftTerm, NOW))!;
      await rejects(
        applyDraft(
          db,
          actor,
          {
            draftId,
            version: view.version,
            acknowledgedConflictKeys: [],
            publish: true,
          },
          NOW,
        ),
        "TEACHER_ARCHIVED",
      );
      await client.user.update({
        where: { id: userIds.Cleo },
        data: { deletedAt: null },
      });

      // G2 (two students) in the one-seat closet.
      const refused = await applyDraft(
        db,
        actor,
        {
          draftId,
          version: view.version,
          acknowledgedConflictKeys: [],
          publish: true,
        },
        NOW,
      );
      expect(refused).toMatchObject({
        ok: false,
        reason: "UNACKNOWLEDGED_CONFLICTS",
        blocking: [],
      });
      const unacknowledged = (refused as { unacknowledged: ApplyIssue[] })
        .unacknowledged;
      expect(
        unacknowledged.map((i) => i.kind === "slot" && i.conflict.type),
      ).toEqual(["ROOM_CAPACITY_EXCEEDED"]);
    });

    it("previews blocking conflicts with publish without failing", async () => {
      const rows = await assignmentsOf(
        (await getDraft(db, ids.draftTerm, NOW))!.id,
      );
      const g2 = rows[ids.g2];
      // G1 and G2 run at the same time: one teacher for both is a clash.
      await client.timetableDraftAssignment.update({
        where: { id: g2.id },
        data: { teacherId: rows[ids.g1].teacherId },
      });
      const preview = await previewApply(
        db,
        actor,
        { draftId: g2.draftId, publish: true },
        NOW,
      );
      expect(
        preview.blocking.map((i) => i.kind === "slot" && i.conflict.type),
      ).toContain("TEACHER_DOUBLE_BOOKED");
      const term = await client.term.findUniqueOrThrow({
        where: { id: ids.draftTerm },
      });
      expect(term.timetablePublishedAt).toBeNull();
      await client.timetableDraftAssignment.update({
        where: { id: g2.id },
        data: { teacherId: g2.teacherId },
      });
    });

    it("previews and applies with publishing", async () => {
      const view = (await getDraft(db, ids.draftTerm, NOW))!;
      const preview = await previewApply(
        db,
        actor,
        { draftId, publish: true },
        NOW,
      );
      // The preview changed nothing.
      expect(
        await client.timetableSlot.count({ where: { termId: ids.draftTerm } }),
      ).toBe(1);
      expect(
        await client.timetableDraft.count({ where: { id: draftId } }),
      ).toBe(1);

      const applied = await applyDraft(
        db,
        actor,
        {
          draftId,
          version: view.version,
          acknowledgedConflictKeys: keys(preview.issues),
          publish: true,
        },
        NOW,
      );
      expect(applied).toMatchObject({ ok: true, published: true });
      const counts = (applied as { counts: unknown }).counts;
      expect(counts).toEqual(preview.counts);
      expect(counts).toMatchObject({
        groups: { assigned: 3, changed: 0, unassigned: 0 },
        slots: { created: 3, deleted: 1 },
        overridden: 1,
      });
      expect(
        (counts as { lessons: { created: number } }).lessons.created,
      ).toBeGreaterThan(20);
      const term = await client.term.findUniqueOrThrow({
        where: { id: ids.draftTerm },
      });
      expect(term.timetablePublishedAt).not.toBeNull();
      const slots = await client.timetableSlot.findMany({
        where: { termId: ids.draftTerm },
      });
      expect(slots.find((s) => s.groupId === ids.g3)!.teacherId).toBe(ids.cleo);
      expect(
        await client.timetableDraft.count({ where: { id: draftId } }),
      ).toBe(0);
      expect(
        await client.auditLog.count({
          where: { schoolId, action: "timetable_draft.applied" },
        }),
      ).toBe(1);
    });
  });

  describe("run lifecycle", () => {
    it("cancels, fails stale runs, and discards changed drafts", async () => {
      // Cancel: nothing is saved.
      const first = await startRun(
        db,
        actor,
        { termId: ids.published, mode: "FILL" },
        NOW,
      );
      await cancelRun(db, first.runId);
      expect(await executeRun(db, first.runId, { now: () => NOW })).toBe(
        "CANCELLED",
      );
      expect(
        await client.timetableDraftAssignment.count({
          where: { draftId: first.draftId },
        }),
      ).toBe(0);

      // A run whose process died: its heartbeat goes stale.
      const second = await startRun(
        db,
        actor,
        { termId: ids.published, mode: "FILL" },
        NOW,
      );
      expect(
        (await getRun(db, second.runId, later(STALE_RUN_MS / 2))).status,
      ).toBe("RUNNING");
      expect(
        await getRun(db, second.runId, later(STALE_RUN_MS + 1000)),
      ).toMatchObject({ status: "FAILED", errorCode: "RUN_INTERRUPTED" });

      // The draft changed under the run: its result is discarded.
      const third = await startRun(
        db,
        actor,
        { termId: ids.published, mode: "FILL" },
        later(STALE_RUN_MS + 2000),
      );
      await client.timetableDraft.update({
        where: { id: third.draftId },
        data: { version: { increment: 1 } },
      });
      expect(await executeRun(db, third.runId, { now: () => NOW })).toBe(
        "FAILED",
      );
      expect(await getRun(db, third.runId, NOW)).toMatchObject({
        errorCode: "DRAFT_CHANGED",
      });
      await discardDraft(db, actor, third.draftId, NOW);

      // Two first runs at once: one starts, the other is refused cleanly.
      const both = await Promise.allSettled([
        startRun(db, actor, { termId: ids.published, mode: "FILL" }, NOW),
        startRun(db, actor, { termId: ids.published, mode: "FILL" }, NOW),
      ]);
      const started = both.filter((r) => r.status === "fulfilled");
      const refused = both.filter((r) => r.status === "rejected");
      expect(started).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "RUN_IN_PROGRESS",
      });
      const { runId, draftId } = (
        started[0] as PromiseFulfilledResult<{ runId: string; draftId: string }>
      ).value;
      await cancelRun(db, runId);
      expect(await executeRun(db, runId, { now: () => NOW })).toBe("CANCELLED");
      await discardDraft(db, actor, draftId, NOW);
      expect(await getDraft(db, ids.published, NOW)).toBeNull();
    });

    it("refuses bad modes and dates", async () => {
      await rejects(
        startRun(db, actor, { termId: ids.published, mode: "REPLACE" }, NOW),
        "TERM_PUBLISHED",
      );
      await rejects(
        startRun(
          db,
          actor,
          { termId: ids.published, mode: "FILL", effectiveFrom: "2026-10-20" },
          NOW,
        ),
        "EFFECTIVE_DATE_PASSED",
      );
      await rejects(
        startRun(
          db,
          actor,
          { termId: ids.published, mode: "FILL", effectiveFrom: "2027-01-04" },
          NOW,
        ),
        "EFFECTIVE_DATE_OUTSIDE_TERM",
      );
    });
  });

  describe("published term: FILL, then REPLAN_FROM", () => {
    it("FILL staffs only the new group, from D", async () => {
      const { draftId, status } = await runToEnd({
        termId: ids.published,
        mode: "FILL",
      });
      expect(status).toBe("DONE");
      // Anna has G1 at that time: G2 goes to Ben.
      expect(Object.values(await assignmentsOf(draftId))).toEqual([
        expect.objectContaining({ groupId: ids.g2, teacherId: ids.ben }),
      ]);
      const preview = await previewApply(
        db,
        actor,
        { draftId, publish: false },
        NOW,
      );
      const view = (await getDraft(db, ids.published, NOW))!;
      const applied = await applyDraft(
        db,
        actor,
        {
          draftId,
          version: view.version,
          acknowledgedConflictKeys: keys(preview.issues),
          publish: false,
        },
        NOW,
      );
      expect(applied).toMatchObject({
        ok: true,
        counts: {
          slots: { created: 1, ended: 0 },
          lessons: { created: 5 },
        },
      });
      const g2 = await client.timetableSlot.findFirstOrThrow({
        where: { termId: ids.published, groupId: ids.g2 },
      });
      expect(toIsoDate(g2.validFrom!)).toBe(D);
      expect(g2.teacherId).toBe(ids.ben);
      // G1 and G3 kept their slots.
      expect(
        await client.timetableSlot.count({
          where: {
            termId: ids.published,
            teacherId: ids.anna,
            validUntil: null,
          },
        }),
      ).toBe(2);
    });

    it("REPLAN_FROM moves groups off an archived teacher and keeps lesson history", async () => {
      const lessonOn = (groupId: string, date: string) =>
        client.lesson.findFirstOrThrow({
          where: { groupId, occurrenceDate: fromIsoDate(date) },
        });
      // History after D: an absence on G1, a booking into G1 from G2, a
      // cancelled 1-on-1 of G3.
      const g1Absent = await lessonOn(ids.g1, "2026-11-02");
      const absence = await client.absenceReport.create({
        data: { schoolId, lessonId: g1Absent.id, studentId: ids.s1 },
      });
      const g2Missed = await lessonOn(ids.g2, "2026-11-02");
      const missed = await client.absenceReport.create({
        data: { schoolId, lessonId: g2Missed.id, studentId: ids.s2 },
      });
      const credit = await client.makeupCredit.create({
        data: {
          schoolId,
          studentId: ids.s2,
          sourceLessonId: g2Missed.id,
          absenceReportId: missed.id,
          status: "USED",
          usedAt: NOW,
          expiresAt: later(30 * 86_400_000),
        },
      });
      const g1Target = await lessonOn(ids.g1, "2026-11-09");
      const booking = await client.replacementRequest.create({
        data: {
          schoolId,
          studentId: ids.s2,
          originalLessonId: g2Missed.id,
          targetLessonId: g1Target.id,
          makeupCreditId: credit.id,
        },
      });
      const g3Cancelled = await lessonOn(ids.g3, "2026-11-04");
      await client.lesson.update({
        where: { id: g3Cancelled.id },
        data: { status: "CANCELLED", cancelReason: "STUDENT_CANCELLED" },
      });
      const g3Before = await lessonOn(ids.g3, "2026-10-21");

      // Anna leaves; Dora teaches B1 now.
      await client.user.update({
        where: { id: userIds.Anna },
        data: { deletedAt: NOW },
      });
      await client.teacherLevel.create({
        data: { schoolId, teacherId: ids.dora, levelId: ids.b1 },
      });

      const { draftId, status } = await runToEnd({
        termId: ids.published,
        mode: "REPLAN_FROM",
      });
      expect(status).toBe("DONE");
      expect(await assignmentsOf(draftId)).toMatchObject({
        [ids.g1]: { teacherId: ids.dora, origin: "GENERATED" },
        [ids.g2]: { teacherId: ids.ben, origin: "IMPORTED" },
        [ids.g3]: { teacherId: ids.cleo, origin: "GENERATED" },
      });

      // A clash someone created after the run refuses the apply.
      const clash = await client.timetableSlot.create({
        data: {
          schoolId,
          termId: ids.published,
          groupId: ids.g2,
          teacherId: ids.dora,
          roomId: ids.closet,
          weekday: 1,
          startMinute: 540,
          endMinute: 630,
          validFrom: fromIsoDate("2026-11-16"),
        },
      });
      const preview = await previewApply(
        db,
        actor,
        { draftId, publish: false },
        NOW,
      );
      const version = (await getDraft(db, ids.published, NOW))!.version;
      const request = {
        draftId,
        version,
        acknowledgedConflictKeys: keys(preview.issues),
        publish: false,
      };
      const refused = await applyDraft(db, actor, request, NOW);
      expect(refused).toMatchObject({
        ok: false,
        reason: "BLOCKING_CONFLICTS",
      });
      expect(
        (refused as { blocking: ApplyIssue[] }).blocking.map(
          (i) => i.kind === "slot" && i.conflict.type,
        ),
      ).toContain("TEACHER_DOUBLE_BOOKED");
      await client.timetableSlot.delete({ where: { id: clash.id } });

      // The effective date must still be ahead.
      await rejects(
        applyDraft(db, actor, request, new Date("2026-10-26T10:00:00Z")),
        "EFFECTIVE_DATE_PASSED",
      );

      const fresh = await previewApply(
        db,
        actor,
        { draftId, publish: false },
        NOW,
      );
      const applied = await applyDraft(
        db,
        actor,
        { ...request, acknowledgedConflictKeys: keys(fresh.issues) },
        NOW,
      );
      expect(applied).toMatchObject({ ok: true });
      const counts = (applied as { counts: { lessons: { repointed: number } } })
        .counts;
      expect(counts).toEqual(fresh.counts);
      expect(counts).toMatchObject({
        groups: { changed: 2 },
        slots: { created: 2, ended: 2 },
        lessons: { created: 0, removed: 0, cancelled: 0 },
      });
      expect(counts.lessons.repointed).toBeGreaterThan(5);
      expect(fresh.replacementBookings).toBe(1);
      expect(fresh.teacherIds).toEqual([ids.anna, ids.cleo, ids.dora].sort());

      // Same rows, new teacher; history stays on them.
      const absent = await client.lesson.findUniqueOrThrow({
        where: { id: g1Absent.id },
        include: { absenceReports: true, timetableSlot: true },
      });
      expect(absent.teacherId).toBe(ids.dora);
      expect(absent.absenceReports.map((a) => a.id)).toEqual([absence.id]);
      expect(toIsoDate(absent.timetableSlot!.validFrom!)).toBe(D);
      const target = await client.replacementRequest.findUniqueOrThrow({
        where: { id: booking.id },
        include: { targetLesson: true },
      });
      expect(target.status).toBe("AUTO_APPROVED");
      expect(target.targetLesson.teacherId).toBe(ids.dora);
      const cancelled = await client.lesson.findUniqueOrThrow({
        where: { id: g3Cancelled.id },
      });
      expect(cancelled).toMatchObject({
        status: "CANCELLED",
        cancelReason: "STUDENT_CANCELLED",
      });
      expect(
        await client.lesson.count({
          where: { groupId: ids.g3, occurrenceDate: fromIsoDate("2026-11-04") },
        }),
      ).toBe(1);
      // Before D nothing changed.
      expect(
        await client.lesson.findUniqueOrThrow({ where: { id: g3Before.id } }),
      ).toMatchObject({
        teacherId: ids.anna,
        timetableSlotId: g3Before.timetableSlotId,
      });
      const oldSlot = await client.timetableSlot.findUniqueOrThrow({
        where: { id: g3Before.timetableSlotId! },
      });
      expect(toIsoDate(oldSlot.validUntil!)).toBe("2026-10-25");
    });

    it("REPLAN_FROM with unchanged data changes nothing", async () => {
      const { draftId, status } = await runToEnd({
        termId: ids.published,
        mode: "REPLAN_FROM",
      });
      expect(status).toBe("DONE");
      const view = (await getDraft(db, ids.published, NOW))!;
      expect(view.summary).toMatchObject({ final: { changedTeachers: 0 } });

      // A running group left without a teacher by a run (not by the admin)
      // keeps its lessons.
      await client.timetableDraftAssignment.updateMany({
        where: { draftId, groupId: ids.g1 },
        data: { teacherId: null, locked: false, origin: "GENERATED" },
      });

      // A pre-existing clash between untouched live slots doesn't refuse.
      const dup = await client.timetableSlot.create({
        data: {
          schoolId,
          termId: ids.published,
          groupId: ids.g2,
          teacherId: ids.ben,
          roomId: ids.closet,
          weekday: 1,
          startMinute: 540,
          endMinute: 630,
          validFrom: fromIsoDate("2026-11-23"),
        },
      });
      const preview = await previewApply(
        db,
        actor,
        { draftId, publish: false },
        NOW,
      );
      const applied = await applyDraft(
        db,
        actor,
        {
          draftId,
          version: view.version,
          acknowledgedConflictKeys: keys(preview.issues),
          publish: false,
        },
        NOW,
      );
      expect(applied).toMatchObject({
        ok: true,
        counts: {
          groups: { changed: 0, unassigned: 1 },
          slots: { created: 0, ended: 0 },
          lessons: { repointed: 0, created: 0, removed: 0, cancelled: 0 },
        },
      });
      expect(
        (applied as { preExisting: ApplyIssue[] }).preExisting.length,
      ).toBeGreaterThan(0);
      await client.timetableSlot.delete({ where: { id: dup.id } });
      expect(
        await client.timetableSlot.count({
          where: {
            groupId: ids.g1,
            termId: ids.published,
            validUntil: null,
          },
        }),
      ).toBe(1);
    });

    it("REPLAN_FROM leaves a group included after the run as it is", async () => {
      // G2 is skipped during the run, so the draft has no row for it.
      await setGroupSkipped(db, actor, {
        termId: ids.published,
        groupId: ids.g2,
        skipped: true,
      });
      const { draftId } = await runToEnd({
        termId: ids.published,
        mode: "REPLAN_FROM",
      });
      expect((await assignmentsOf(draftId))[ids.g2]).toBeUndefined();
      await setGroupSkipped(db, actor, {
        termId: ids.published,
        groupId: ids.g2,
        skipped: false,
      });
      const lessonsBefore = await client.lesson.count({
        where: { groupId: ids.g2, status: "SCHEDULED" },
      });
      const view = (await getDraft(db, ids.published, NOW))!;
      expect(view.outOfDate).toBe(true);
      const preview = await previewApply(
        db,
        actor,
        { draftId, publish: false },
        NOW,
      );
      const applied = await applyDraft(
        db,
        actor,
        {
          draftId,
          version: view.version,
          acknowledgedConflictKeys: keys(preview.issues),
          publish: false,
        },
        NOW,
      );
      expect(applied).toMatchObject({
        ok: true,
        counts: {
          slots: { created: 0, ended: 0, deleted: 0 },
          lessons: { removed: 0, cancelled: 0 },
        },
      });
      expect(
        await client.timetableSlot.count({
          where: { groupId: ids.g2, termId: ids.published, validUntil: null },
        }),
      ).toBe(1);
      expect(
        await client.lesson.count({
          where: { groupId: ids.g2, status: "SCHEDULED" },
        }),
      ).toBe(lessonsBefore);
    });

    it("REPLAN_FROM ends a group's lessons only when the admin sets no teacher", async () => {
      const { draftId } = await runToEnd({
        termId: ids.published,
        mode: "REPLAN_FROM",
      });
      const view = (await getDraft(db, ids.published, NOW))!;
      const saved = await saveAssignment(
        db,
        { draftId, version: view.version, groupId: ids.g3, teacherId: null },
        NOW,
      );
      expect(saved.ok).toBe(true);
      const version = (saved as { draft: { version: number } }).draft.version;
      const preview = await previewApply(
        db,
        actor,
        { draftId, publish: false },
        NOW,
      );
      const applied = await applyDraft(
        db,
        actor,
        {
          draftId,
          version,
          acknowledgedConflictKeys: keys(preview.issues),
          publish: false,
        },
        NOW,
      );
      expect(applied).toMatchObject({
        ok: true,
        counts: { groups: { unassigned: 1 }, slots: { ended: 1 } },
      });
      const g3 = await client.timetableSlot.findFirstOrThrow({
        where: { groupId: ids.g3, termId: ids.published, teacherId: ids.cleo },
      });
      expect(toIsoDate(g3.validUntil!)).toBe("2026-10-25");
      expect(
        await client.lesson.count({
          where: {
            groupId: ids.g3,
            termId: ids.published,
            status: "SCHEDULED",
            occurrenceDate: { gte: fromIsoDate(D) },
          },
        }),
      ).toBe(0);
    });
  });

  describe("school scoping", () => {
    it("treats another school's ids as not found", async () => {
      const { draftId } = await startRun(
        db,
        actor,
        { termId: ids.published, mode: "REPLAN_FROM" },
        NOW,
      );
      const run = await client.generatorRun.findFirstOrThrow({
        where: { draftId },
      });
      expect(await getDraft(otherDb, ids.published, NOW)).toBeNull();
      await rejects(getRun(otherDb, run.id, NOW), "NOT_FOUND");
      await rejects(cancelRun(otherDb, run.id), "NOT_FOUND");
      await rejects(
        startRun(
          otherDb,
          actor,
          { termId: ids.published, mode: "REPLAN_FROM" },
          NOW,
        ),
        "NOT_FOUND",
      );
      await rejects(
        checkReadiness(otherDb, ids.published, {}, NOW),
        "NOT_FOUND",
      );
      await rejects(
        setGroupSkipped(otherDb, actor, {
          termId: ids.published,
          groupId: ids.g1,
          skipped: true,
        }),
        "NOT_FOUND",
      );
      await rejects(
        teacherOptions(otherDb, { draftId, groupId: ids.g2 }, NOW),
        "NOT_FOUND",
      );
      await rejects(checkDraft(otherDb, { draftId }, NOW), "NOT_FOUND");
      expect(await executeRun(otherDb, run.id, { now: () => NOW })).toBe(
        "FAILED",
      );
      expect((await getRun(db, run.id, NOW)).status).toBe("RUNNING");
      await cancelRun(db, run.id);
      await executeRun(db, run.id, { now: () => NOW });
      await discardDraft(db, actor, draftId, NOW);
    });
  });
});
