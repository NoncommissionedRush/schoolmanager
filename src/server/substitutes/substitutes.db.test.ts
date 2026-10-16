// Substitutes against a real Postgres (docs/architecture/phase5-rules.md
// §3.5, §7). Opt-in, like the other DB tests: set
// SCHEDULING_TEST_DATABASE_URL to a migrated database (never your dev
// database; the test creates and deletes its own schools).

import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { AdminError } from "@/server/admin/result";
import { scopeToSchool } from "@/server/db/school-scope";
import { fromIsoDate, zonedTimeToUtc } from "@/server/scheduling";
import type { SchoolDb } from "@/server/timetable/service";

import {
  assignSubstitute,
  countNeedsCover,
  listCovered,
  listNeedsCover,
  listPastSubstitutions,
  listTeacherSubstitutions,
  loadSubstituteSheet,
  removeSubstitute,
} from "./service";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
const TZ = "Europe/Bratislava";
const local = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return zonedTimeToUtc(date, h * 60 + m, TZ);
};
// Mon 19 Oct 2026, 12:00.
const NOW = local("2026-10-19", "12:00");

describe.skipIf(!url)("substitutes (database)", () => {
  // Unique per file: the cleanup deletes only this file's users.
  const suffix = randomUUID().slice(0, 8);
  let client: PrismaClient;
  let db: SchoolDb;
  let otherDb: SchoolDb;
  let schoolId: string;
  const schools: string[] = [];
  const user: Record<string, string> = {};
  const ids = {
    tomas: randomUUID(), // regular teacher
    ana: randomUUID(),
    eva: randomUUID(),
    jozef: randomUUID(), // busy at the lesson's time
    cara: randomUUID(),
    dan: randomUUID(),
    group: randomUUID(),
    other: randomUUID(),
    room: randomUUID(),
    room2: randomUUID(),
    term: randomUUID(),
  };
  const lessons = {
    tue: randomUUID(), // Tue 20 Oct 17:00–18:30, B1 Evening, Tomas
    busy: randomUUID(), // Tue 20 Oct 17:00–18:30, C1, Jozef
    wed: randomUUID(), // Wed 21 Oct 17:00–18:30, B1 Evening, Tomas
    past: randomUUID(), // Mon 12 Oct (ended 7 days ago, minus a bit)
    old: randomUUID(), // Fri 9 Oct (ended more than 7 days ago)
    foreign: randomUUID(),
  };
  const actor = () => ({ userId: user.Admin });
  const notifications = (where: Record<string, unknown> = {}) =>
    client.notification.findMany({
      where: { schoolId, ...where },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  const input = (
    lessonId: string,
    expectedSubstituteId: string | null,
    startsAt: Date,
    extra: Record<string, unknown> = {},
  ) => ({
    lessonId,
    expectedSubstituteId,
    expectedStartsAt: startsAt.toISOString(),
    acknowledgedKeys: [] as string[],
    reason: null,
    ...extra,
  });

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    const school = await client.school.create({
      data: { name: `Sub ${suffix}`, slug: `sub-${suffix}`, timezone: TZ },
    });
    const other = await client.school.create({
      data: { name: `Sub O ${suffix}`, slug: `sub-o-${suffix}`, timezone: TZ },
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
    const b1 = await client.level.create({
      data: { schoolId, code: "B1", name: "B1", rank: 1 },
    });
    const c1 = await client.level.create({
      data: { schoolId, code: "C1", name: "C1", rank: 2 },
    });
    for (const [name, id] of [
      ["Tomas", ids.tomas],
      ["Ana", ids.ana],
      ["Eva", ids.eva],
      ["Jozef", ids.jozef],
    ] as const) {
      await client.teacherProfile.create({
        data: { id, schoolId, userId: await person(name, "TEACHER") },
      });
      await client.teacherLevel.create({
        data: {
          schoolId,
          teacherId: id,
          levelId: name === "Jozef" ? c1.id : b1.id,
        },
      });
    }
    await client.studentProfile.createMany({
      data: [
        { id: ids.cara, schoolId, userId: await person("Cara", "STUDENT") },
        { id: ids.dan, schoolId, userId: await person("Dan", "STUDENT") },
      ],
    });
    await client.group.createMany({
      data: [
        {
          id: ids.group,
          schoolId,
          levelId: b1.id,
          type: "GROUP",
          name: "B1 Evening",
          capacity: 8,
        },
        {
          id: ids.other,
          schoolId,
          levelId: c1.id,
          type: "GROUP",
          name: "C1 Business",
          capacity: 8,
        },
      ],
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
    await client.room.createMany({
      data: [
        {
          id: ids.room,
          schoolId,
          name: "Room 3",
          kind: "PHYSICAL",
          capacity: 8,
        },
        {
          id: ids.room2,
          schoolId,
          name: "Room 4",
          kind: "PHYSICAL",
          capacity: 8,
        },
      ],
    });
    await client.term.create({
      data: {
        id: ids.term,
        schoolId,
        name: "Autumn",
        startDate: fromIsoDate("2026-10-05"),
        endDate: fromIsoDate("2026-12-18"),
        timetablePublishedAt: new Date("2026-10-01"),
      },
    });
    const lesson = (
      id: string,
      groupId: string,
      teacherId: string,
      roomId: string,
      date: string,
    ) => ({
      id,
      schoolId,
      termId: ids.term,
      groupId,
      teacherId,
      roomId,
      startsAt: local(date, "17:00"),
      endsAt: local(date, "18:30"),
    });
    await client.lesson.createMany({
      data: [
        lesson(lessons.tue, ids.group, ids.tomas, ids.room, "2026-10-20"),
        lesson(lessons.busy, ids.other, ids.jozef, ids.room2, "2026-10-20"),
        lesson(lessons.wed, ids.group, ids.tomas, ids.room, "2026-10-21"),
        lesson(lessons.past, ids.group, ids.tomas, ids.room, "2026-10-12"),
        lesson(lessons.old, ids.group, ids.tomas, ids.room, "2026-10-09"),
      ],
    });
    // Tomas is away on Tuesday (one-off).
    await client.teacherAvailability.create({
      data: {
        schoolId,
        teacherId: ids.tomas,
        kind: "DATE_UNAVAILABLE",
        date: fromIsoDate("2026-10-20"),
      },
    });
  });

  afterAll(async () => {
    if (!client) return;
    const where = { where: { schoolId: { in: schools } } };
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

  it("lists the lesson as needing cover, with why", async () => {
    const rows = await listNeedsCover(
      db,
      { from: "2026-10-19", to: "2026-12-14" },
      NOW,
    );
    expect(
      rows.map((r) => [r.lessonId, r.needsCover?.who, r.needsCover?.reasons]),
    ).toEqual([[lessons.tue, "REGULAR", ["UNAVAILABLE_ON_DATE"]]]);
    // Cover a teacher: every lesson of Tomas in the range.
    const all = await listNeedsCover(
      db,
      {
        from: "2026-10-19",
        to: "2026-10-25",
        teacherId: ids.tomas,
        allOfTeacher: true,
      },
      NOW,
    );
    expect(all.map((r) => r.lessonId)).toEqual([lessons.tue, lessons.wed]);
  });

  it("counts needs cover without loading rows, and caps the date range", async () => {
    expect(await countNeedsCover(db, NOW)).toBe(1);
    // Ten years asked for: capped to SUBSTITUTION_RANGE_MAX_DAYS (the cap
    // itself is unit-tested in scheduling/substitutes.test.ts).
    const rows = await listNeedsCover(
      db,
      { from: "2026-10-19", to: "2036-10-19" },
      NOW,
    );
    expect(rows.map((r) => r.lessonId)).toEqual([lessons.tue]);
  });

  it("the sheet ranks the candidates and previews who will be notified", async () => {
    const sheet = await loadSubstituteSheet(db, actor(), lessons.tue, NOW);
    expect(sheet.lesson).toMatchObject({
      groupName: "B1 Evening",
      regular: { id: ids.tomas, name: "Tomas" },
      substitute: null,
      phase: "upcoming",
    });
    expect(sheet.needsCover?.reasons).toEqual(["UNAVAILABLE_ON_DATE"]);
    expect(sheet.lessonReasons).toEqual([]);
    expect(sheet.candidates.map((c) => [c.name, c.band])).toEqual([
      ["Ana", "SUGGESTED"],
      ["Eva", "SUGGESTED"],
      ["Jozef", "NOT_POSSIBLE"],
    ]);
    const jozef = sheet.candidates.find((c) => c.name === "Jozef")!;
    expect(jozef.reasons.map((r) => r.code)).toEqual([
      "BUSY",
      "LEVEL_NOT_TAUGHT",
    ]);
    expect(sheet.candidates[0].notify).toEqual({
      teachers: [
        { id: user.Ana, name: "Ana", audience: "substitute" },
        { id: user.Tomas, name: "Tomas", audience: "regular" },
      ],
      studentCount: 2,
    });
  });

  it("refuses a busy teacher and needs warnings acknowledged", async () => {
    const tue = local("2026-10-20", "17:00");
    const busy = await assignSubstitute(
      db,
      actor(),
      { ...input(lessons.tue, null, tue), teacherId: ids.jozef },
      NOW,
    );
    expect(busy).toMatchObject({ status: "refused" });
    // Eva at her weekly max: overridable.
    await client.teacherProfile.update({
      where: { id: ids.eva },
      data: { maxMinutesPerWeek: 60 },
    });
    const warned = await assignSubstitute(
      db,
      actor(),
      { ...input(lessons.tue, null, tue), teacherId: ids.eva },
      NOW,
    );
    expect(warned).toMatchObject({
      status: "unacknowledged",
      reasons: [
        { code: "OVER_MAX_HOURS", key: `sub:${ids.eva}|OVER_MAX_HOURS` },
      ],
    });
    await client.teacherProfile.update({
      where: { id: ids.eva },
      data: { maxMinutesPerWeek: null },
    });
    expect(await notifications()).toEqual([]);
  });

  it("assigns once: a repeat with the old expectation is LESSON_CHANGED and notifies nobody again", async () => {
    const tue = local("2026-10-20", "17:00");
    const request = {
      ...input(lessons.tue, null, tue),
      teacherId: ids.ana,
      reason: "Tomas is ill",
    };
    expect(await assignSubstitute(db, actor(), request, NOW)).toMatchObject({
      status: "done",
      name: "Ana",
      group: "B1 Evening",
    });
    expect(await assignSubstitute(db, actor(), request, NOW)).toEqual({
      status: "changed",
    });

    const row = await client.lesson.findUniqueOrThrow({
      where: { id: lessons.tue },
    });
    expect(row.substituteTeacherId).toBe(ids.ana);
    const sent = await notifications({ type: "SUBSTITUTE_ASSIGNED" });
    expect(sent.map((n) => [n.recipientId, n.audience]).sort()).toEqual(
      [
        [user.Ana, "substitute"],
        [user.Tomas, "regular"],
        [user.Cara, "student"],
        [user.Dan, "student"],
      ].sort(),
    );
    const audit = await client.auditLog.findMany({
      where: {
        schoolId,
        entityId: lessons.tue,
        action: { startsWith: "lesson.substitute" },
      },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "lesson.substitute_assigned",
      actorId: user.Admin,
    });
    expect(audit[0].data).toMatchObject({
      lessonId: lessons.tue,
      from: null,
      to: ids.ana,
      reason: "Tomas is ill",
      overridden: [],
      recordedAfterEnd: false,
    });
    // The lesson no longer needs cover; it's in Covered and on both teachers' lists.
    expect(
      await listNeedsCover(db, { from: "2026-10-19", to: "2026-12-14" }, NOW),
    ).toEqual([]);
    expect(
      (
        await listCovered(db, { from: "2026-10-19", to: "2026-12-14" }, NOW)
      ).map((r) => r.lessonId),
    ).toEqual([lessons.tue]);
    const ana = await listTeacherSubstitutions(
      db,
      ids.ana,
      { past: false },
      NOW,
    );
    expect(ana.covering.map((r) => r.lessonId)).toEqual([lessons.tue]);
    const tomas = await listTeacherSubstitutions(
      db,
      ids.tomas,
      { past: false },
      NOW,
    );
    expect(
      tomas.coveredForMe.map((r) => [r.lessonId, r.substitute?.name]),
    ).toEqual([[lessons.tue, "Ana"]]);
  });

  it("an assign racing a lesson move is LESSON_CHANGED", async () => {
    const wed = local("2026-10-21", "17:00");
    // The admin opened the sheet; meanwhile the lesson moved an hour later.
    await client.lesson.update({
      where: { id: lessons.wed },
      data: {
        startsAt: local("2026-10-21", "18:00"),
        endsAt: local("2026-10-21", "19:30"),
      },
    });
    expect(
      await assignSubstitute(
        db,
        actor(),
        { ...input(lessons.wed, null, wed), teacherId: ids.eva },
        NOW,
      ),
    ).toEqual({ status: "changed" });
    expect(
      (await client.lesson.findUniqueOrThrow({ where: { id: lessons.wed } }))
        .substituteTeacherId,
    ).toBeNull();
  });

  it("changing the substitute tells the previous one; the others' unread item is updated", async () => {
    const tue = local("2026-10-20", "17:00");
    expect(
      await assignSubstitute(
        db,
        actor(),
        { ...input(lessons.tue, ids.ana, tue), teacherId: ids.eva },
        NOW,
      ),
    ).toMatchObject({ status: "done", name: "Eva" });
    // Ana: assigned then taken off → nothing changed for her, the row goes.
    expect(await notifications({ recipientId: user.Ana })).toEqual([]);
    const eva = await notifications({ recipientId: user.Eva });
    expect(eva.map((n) => [n.type, n.audience])).toEqual([
      ["SUBSTITUTE_ASSIGNED", "substitute"],
    ]);
    // Tomas and the students still have one unread item, now about Eva.
    const tomas = await notifications({ recipientId: user.Tomas });
    expect(tomas).toHaveLength(1);
    expect(tomas[0].params).toMatchObject({
      substitute: "Eva",
      fromId: null,
      toId: user.Eva,
    });
    const audit = await client.auditLog.findFirstOrThrow({
      where: { schoolId, action: "lesson.substitute_changed" },
    });
    expect(audit.data).toMatchObject({ from: ids.ana, to: ids.eva });
  });

  it("remove is refused while the regular teacher teaches another lesson then", async () => {
    // Tomas is given Jozef's C1 lesson at the same time.
    await client.lesson.update({
      where: { id: lessons.busy },
      data: { teacherId: ids.tomas },
    });
    const tue = local("2026-10-20", "17:00");
    expect(
      await removeSubstitute(
        db,
        actor(),
        input(lessons.tue, ids.eva, tue),
        NOW,
      ),
    ).toEqual({
      status: "regularBusy",
      otherGroup: "C1 Business",
    });
    await client.lesson.update({
      where: { id: lessons.busy },
      data: { teacherId: ids.jozef },
    });
  });

  it("remove is refused while the regular teacher is archived", async () => {
    await client.user.update({
      where: { id: user.Tomas },
      data: { deletedAt: new Date("2026-10-18") },
    });
    try {
      const sheet = await loadSubstituteSheet(db, actor(), lessons.tue, NOW);
      expect(sheet.remove).toMatchObject({
        refused: true,
        refusal: "REGULAR_TEACHER_ARCHIVED",
        reasons: [],
      });
      const tue = local("2026-10-20", "17:00");
      expect(
        await removeSubstitute(
          db,
          actor(),
          input(lessons.tue, ids.eva, tue, {
            acknowledgedKeys: [`sub:${ids.tomas}|UNAVAILABLE_ON_DATE`],
          }),
          NOW,
        ),
      ).toEqual({ status: "regularArchived" });
      expect(
        (await client.lesson.findUniqueOrThrow({ where: { id: lessons.tue } }))
          .substituteTeacherId,
      ).toBe(ids.eva);
    } finally {
      await client.user.update({
        where: { id: user.Tomas },
        data: { deletedAt: null },
      });
    }
  });

  it("a write landing between the checks and the update is LESSON_CHANGED", async () => {
    // Writers outside the timetable lock (none today) could still change
    // the row after the checks: hold its row lock, let remove block on its
    // conditional update, then change the substitute and commit.
    const tue = local("2026-10-20", "17:00");
    const before = (await notifications()).length;
    let pending: Promise<unknown> | undefined;
    await client.$transaction(
      async (other) => {
        await other.$queryRaw`SELECT id FROM lessons WHERE id = ${lessons.tue}::uuid FOR UPDATE`;
        pending = removeSubstitute(
          db,
          actor(),
          input(lessons.tue, ids.eva, tue, {
            acknowledgedKeys: [`sub:${ids.tomas}|UNAVAILABLE_ON_DATE`],
          }),
          NOW,
        );
        // Wait until remove's UPDATE is blocked on our row lock.
        for (let i = 0; ; i++) {
          const [{ n }] = await client.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%UPDATE%lessons%substitute_teacher_id%'`;
          if (n > 0) break;
          if (i > 200) throw new Error("remove never reached its update");
          await new Promise((r) => setTimeout(r, 25));
        }
        await other.lesson.update({
          where: { id: lessons.tue },
          data: { substituteTeacherId: ids.ana },
        });
      },
      { timeout: 15_000 },
    );
    await expect(pending).resolves.toEqual({ status: "changed" });
    expect(
      await client.auditLog.count({
        where: { schoolId, action: "lesson.substitute_removed" },
      }),
    ).toBe(0);
    expect(await notifications()).toHaveLength(before);
    await client.lesson.update({
      where: { id: lessons.tue },
      data: { substituteTeacherId: ids.eva },
    });
  });

  it("remove needs Tomas's absence acknowledged, then notifies and deletes the unread items", async () => {
    const tue = local("2026-10-20", "17:00");
    const first = await removeSubstitute(
      db,
      actor(),
      input(lessons.tue, ids.eva, tue),
      NOW,
    );
    expect(first).toMatchObject({
      status: "unacknowledged",
      reasons: [
        {
          code: "UNAVAILABLE_ON_DATE",
          key: `sub:${ids.tomas}|UNAVAILABLE_ON_DATE`,
        },
      ],
    });
    const done = await removeSubstitute(
      db,
      actor(),
      input(lessons.tue, ids.eva, tue, {
        acknowledgedKeys: [`sub:${ids.tomas}|UNAVAILABLE_ON_DATE`],
      }),
      NOW,
    );
    expect(done).toMatchObject({ status: "done", name: "Eva" });
    // Assigned then removed while unread: nothing changed for anyone.
    expect(await notifications()).toEqual([]);
    const audit = await client.auditLog.findFirstOrThrow({
      where: { schoolId, action: "lesson.substitute_removed" },
    });
    expect(audit.data).toMatchObject({
      from: ids.eva,
      to: null,
      overridden: [{ code: "UNAVAILABLE_ON_DATE" }],
    });
  });

  it("records a substitute after the lesson for 7 days, notifying nobody", async () => {
    const past = local("2026-10-12", "17:00");
    const result = await assignSubstitute(
      db,
      actor(),
      { ...input(lessons.past, null, past), teacherId: ids.ana },
      NOW,
    );
    expect(result).toMatchObject({ status: "done" });
    expect(await notifications()).toEqual([]);
    const audit = await client.auditLog.findFirstOrThrow({
      where: { schoolId, entityId: lessons.past },
    });
    expect(audit.data).toMatchObject({ recordedAfterEnd: true });
    const rows = await listPastSubstitutions(db, { termId: ids.term }, NOW);
    expect(rows.map((r) => [r.lessonId, r.editable])).toEqual([
      [lessons.past, true],
    ]);

    const old = local("2026-10-09", "17:00");
    expect(
      await assignSubstitute(
        db,
        actor(),
        { ...input(lessons.old, null, old), teacherId: ids.ana },
        NOW,
      ),
    ).toEqual({ status: "lessonRefused", reasons: ["TOO_LATE_TO_RECORD"] });
  });

  it("another school's lesson or teacher is not found", async () => {
    await expect(
      loadSubstituteSheet(otherDb, actor(), lessons.tue, NOW),
    ).rejects.toBeInstanceOf(AdminError);
    await expect(
      assignSubstitute(
        otherDb,
        actor(),
        {
          ...input(lessons.wed, null, local("2026-10-21", "18:00")),
          teacherId: ids.ana,
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(AdminError);
  });
});
