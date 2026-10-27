// Changing only a slot's teacher in the editor keeps its lessons
// (generator.md §5.6, §10 Q3, CARM-61): they move to the new teacher with
// their absences, bookings and substitutes, and nothing is cancelled.
// Against a real Postgres; opt-in, like the other DB tests: set
// SCHEDULING_TEST_DATABASE_URL to a migrated database (never your dev
// database; the test creates and deletes its own school).

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { createPgAdapter } from "@/lib/pg-adapter";
import { scopeToSchool } from "@/server/db/school-scope";
import { bookReplacement } from "@/server/replacements/booking";
import { reportAbsence } from "@/server/replacements/service";
import { fromIsoDate } from "@/server/scheduling";

import {
  publishTerm,
  regenerateLessons,
  saveSlot,
  type SchoolDb,
  type SlotInput,
  type SlotRequest,
  validateSlot,
} from "./service";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
// Tue 20 Oct 2026, 12:00 in Bratislava; the default cutoff is 24 hours.
const NOW = new Date("2026-10-20T10:00:00Z");

describe.skipIf(!url)("teacher-only slot changes (database)", () => {
  let client: PrismaClient;
  let db: SchoolDb;
  let schoolId: string;
  let admin: { userId: string };
  const users: Record<string, string> = {};
  const ids = {
    term: randomUUID(),
    level: randomUUID(),
    tess: randomUUID(),
    tom: randomUUID(),
    sam: randomUUID(),
    otherLevel: randomUUID(),
    cara: randomUUID(),
    dan: randomUUID(),
    eve: randomUUID(),
    olga: randomUUID(),
    groupG: randomUUID(), // Cara and Dan, Mon 17:00 with Tess
    groupB: randomUUID(), // Eve, Thu 10:00 with Tom
    oneOnOne: randomUUID(), // Olga, Tue 16:00 with Tess
    big: randomUUID(),
    small: randomUUID(),
    booth: randomUUID(),
  };
  const slots: Record<"g" | "b" | "o", string> = { g: "", b: "", o: "" };

  const lessonOn = (slotId: string, date: string) =>
    client.lesson.findUnique({
      where: {
        timetableSlotId_occurrenceDate: {
          timetableSlotId: slotId,
          occurrenceDate: fromIsoDate(date),
        },
      },
    });

  const edit = (
    key: "g" | "o",
    slot: SlotInput,
    effectiveFrom: string,
  ): SlotRequest => ({ slotId: slots[key], slot, effectiveFrom });

  const gSlot = (extra: Partial<SlotInput> = {}): SlotInput => ({
    termId: ids.term,
    groupId: ids.groupG,
    teacherId: ids.tess,
    roomId: ids.big,
    weekday: 1,
    startMinute: 17 * 60,
    endMinute: 18 * 60 + 30,
    ...extra,
  });
  const oSlot = (extra: Partial<SlotInput> = {}): SlotInput => ({
    termId: ids.term,
    groupId: ids.oneOnOne,
    teacherId: ids.tess,
    roomId: ids.booth,
    weekday: 2,
    startMinute: 16 * 60,
    endMinute: 16 * 60 + 45,
    ...extra,
  });

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: createPgAdapter(url),
    });
    const suffix = randomUUID().slice(0, 8);
    const school = await client.school.create({
      data: {
        name: `Teacher change ${suffix}`,
        slug: `teacher-change-${suffix}`,
      },
    });
    schoolId = school.id;
    db = scopeToSchool(client, schoolId);
    const person = async (
      name: string,
      role: "ADMIN" | "TEACHER" | "STUDENT",
    ) => {
      const row = await client.user.create({
        data: { name, email: `${name.toLowerCase()}-${suffix}@example.test` },
      });
      users[name] = row.id;
      await client.membership.create({
        data: { schoolId, userId: row.id, role },
      });
      return row.id;
    };
    admin = { userId: await person("Admin", "ADMIN") };
    await client.teacherProfile.createMany({
      data: [
        { id: ids.tess, schoolId, userId: await person("Tess", "TEACHER") },
        { id: ids.tom, schoolId, userId: await person("Tom", "TEACHER") },
        { id: ids.sam, schoolId, userId: await person("Sam", "TEACHER") },
      ],
    });
    await client.level.create({
      data: { id: ids.level, schoolId, code: "B1", name: "B1", rank: 1 },
    });
    const student = async (id: string, name: string) => ({
      id,
      schoolId,
      levelId: ids.level,
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
        { id: ids.big, schoolId, name: "Big", kind: "PHYSICAL", capacity: 10 },
        {
          id: ids.small,
          schoolId,
          name: "Small",
          kind: "PHYSICAL",
          capacity: 4,
        },
        {
          id: ids.booth,
          schoolId,
          name: "Booth",
          kind: "PHYSICAL",
          capacity: 1,
        },
      ],
    });
    const group = (id: string, name: string, type: "GROUP" | "ONE_ON_ONE") => ({
      id,
      schoolId,
      levelId: ids.level,
      type,
      name,
      capacity: type === "GROUP" ? 8 : 1,
    });
    await client.group.createMany({
      data: [
        group(ids.groupG, "G Evening", "GROUP"),
        group(ids.groupB, "B Morning", "GROUP"),
        group(ids.oneOnOne, "Olga 1-on-1", "ONE_ON_ONE"),
      ],
    });
    const joinedAt = new Date("2026-09-01T00:00:00Z");
    await client.groupMembership.createMany({
      data: [
        { schoolId, groupId: ids.groupG, studentId: ids.cara, joinedAt },
        { schoolId, groupId: ids.groupG, studentId: ids.dan, joinedAt },
        { schoolId, groupId: ids.groupB, studentId: ids.eve, joinedAt },
        { schoolId, groupId: ids.oneOnOne, studentId: ids.olga, joinedAt },
      ],
    });
    await client.term.create({
      data: {
        id: ids.term,
        schoolId,
        name: "Autumn",
        startDate: new Date("2026-09-14T00:00:00Z"),
        endDate: new Date("2026-12-18T00:00:00Z"),
      },
    });
    for (const [key, slot] of [
      ["g", gSlot()],
      [
        "b",
        {
          ...gSlot(),
          groupId: ids.groupB,
          teacherId: ids.tom,
          roomId: ids.small,
          weekday: 4,
          startMinute: 10 * 60,
          endMinute: 11 * 60 + 30,
        },
      ],
      ["o", oSlot()],
    ] as const) {
      const result = await saveSlot(db, admin, { slot }, NOW);
      if (!result.ok) throw new Error(JSON.stringify(result));
      slots[key] = result.slotId;
    }
    expect(await publishTerm(db, admin, ids.term, NOW)).toMatchObject({
      ok: true,
    });
  });

  afterAll(async () => {
    if (!client) return;
    const where = { where: { schoolId } };
    await client.teacherLevel.deleteMany(where);
    await client.replacementRequest.deleteMany(where);
    await client.makeupCredit.deleteMany(where);
    await client.absenceReport.deleteMany(where);
    await client.lesson.updateMany({
      ...where,
      data: { rescheduledFromId: null },
    });
    await client.lesson.deleteMany(where);
    await client.school.deleteMany({ where: { id: schoolId } });
    await client.user.deleteMany({
      where: { id: { in: Object.values(users) } },
    });
    await client.$disconnect();
  });

  it("moves a group's lessons to the new teacher with their absences, bookings and substitutes", async () => {
    const oldSlot = slots.g;
    // Publishing at NOW created lessons from Mon 26 Oct; the change starts
    // on Mon 2 Nov, so 26 Oct stays with Tess.
    const gBefore = (await lessonOn(oldSlot, "2026-10-26"))!;
    const gMon = (await lessonOn(oldSlot, "2026-11-02"))!;
    const gSam = (await lessonOn(oldSlot, "2026-11-09"))!;
    const gTom = (await lessonOn(oldSlot, "2026-11-16"))!;
    const bThu = (await lessonOn(slots.b, "2026-10-22"))!;
    const student = (name: string) => ({
      userId: users[name],
      role: "STUDENT" as const,
    });
    const cara = await reportAbsence(
      db,
      student("Cara"),
      { lessonId: gMon.id, reason: null },
      NOW,
    );
    const eve = await reportAbsence(
      db,
      student("Eve"),
      { lessonId: bThu.id, reason: null },
      NOW,
    );
    if (cara.status !== "reported" || eve.status !== "reported") {
      throw new Error("absences not reported");
    }
    expect(
      await bookReplacement(
        db,
        { userId: users.Eve },
        { creditId: eve.credit!.id, targetLessonId: gMon.id },
        NOW,
      ),
    ).toMatchObject({ status: "booked" });
    const booking = await client.replacementRequest.findFirstOrThrow({
      where: { studentId: ids.eve, targetLessonId: gMon.id },
    });
    await client.lesson.update({
      where: { id: gSam.id },
      data: { substituteTeacherId: ids.sam },
    });
    await client.lesson.update({
      where: { id: gTom.id },
      data: { substituteTeacherId: ids.tom },
    });
    // Tom teaches only another level: the editor warns before saving.
    await client.level.create({
      data: { id: ids.otherLevel, schoolId, code: "C1", name: "C1", rank: 2 },
    });
    await client.teacherLevel.create({
      data: { schoolId, teacherId: ids.tom, levelId: ids.otherLevel },
    });

    const request = edit("g", gSlot({ teacherId: ids.tom }), "2026-11-02");
    const conflicts = await validateSlot(db, request, NOW);
    expect(conflicts.map((c) => [c.type, c.severity])).toEqual([
      ["TEACHER_LEVEL_NOT_TAUGHT", "overridable"],
    ]);
    expect(await saveSlot(db, admin, request, NOW)).toMatchObject({
      ok: false,
      reason: "UNACKNOWLEDGED_CONFLICTS",
    });
    const result = await saveSlot(
      db,
      admin,
      { ...request, acknowledgedConflictKeys: conflicts.map((c) => c.key) },
      NOW,
    );
    if (!result.ok) throw new Error(JSON.stringify(result));
    slots.g = result.slotId;
    expect(result.endedSlotId).toBe(oldSlot);
    expect(result.slotId).not.toBe(oldSlot);
    expect(result.lessons).toMatchObject({ removed: 0, cancelled: 0 });
    expect(result.lessons.moved).toBe(7); // 2 Nov – 14 Dec

    // The same rows, on the new slot with the new teacher.
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: gMon.id } }),
    ).toMatchObject({
      timetableSlotId: result.slotId,
      teacherId: ids.tom,
      status: "SCHEDULED",
    });
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: gSam.id } }),
    ).toMatchObject({ teacherId: ids.tom, substituteTeacherId: ids.sam });
    // The new teacher was the substitute: nobody substitutes any more.
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: gTom.id } }),
    ).toMatchObject({ teacherId: ids.tom, substituteTeacherId: null });
    expect(
      await client.absenceReport.findUniqueOrThrow({
        where: { id: cara.absenceId },
      }),
    ).toMatchObject({ lessonId: gMon.id });
    expect(
      await client.makeupCredit.findUniqueOrThrow({
        where: { id: cara.credit!.id },
      }),
    ).toMatchObject({ sourceLessonId: gMon.id, status: "AVAILABLE" });
    expect(
      await client.replacementRequest.findUniqueOrThrow({
        where: { id: booking.id },
      }),
    ).toMatchObject({ targetLessonId: gMon.id, status: "AUTO_APPROVED" });
    // Before the date nothing changes, and nothing is cancelled.
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: gBefore.id } }),
    ).toMatchObject({ timetableSlotId: oldSlot, teacherId: ids.tess });
    expect(
      await client.lesson.count({
        where: { groupId: ids.groupG, status: "CANCELLED" },
      }),
    ).toBe(0);
    expect(
      await client.lesson.count({
        where: {
          timetableSlotId: oldSlot,
          occurrenceDate: { gte: fromIsoDate("2026-11-02") },
        },
      }),
    ).toBe(0);
    expect(
      await client.auditLog.findFirst({
        where: {
          schoolId,
          action: "timetable_slot.updated",
          entityId: oldSlot,
        },
      }),
    ).toMatchObject({
      data: {
        mode: "teacherChange",
        previousTeacherId: ids.tess,
        newSlotId: result.slotId,
        overridden: [{ type: "TEACHER_LEVEL_NOT_TAUGHT" }],
      },
    });
    await client.teacherLevel.deleteMany({ where: { schoolId } });
  });

  it("keeps a cancelled 1-on-1 cancelled and checks lessons with their own time", async () => {
    const oldSlot = slots.o;
    const oToday = (await lessonOn(oldSlot, "2026-10-20"))!;
    const oTue = (await lessonOn(oldSlot, "2026-10-27"))!;
    const olga = await reportAbsence(
      db,
      { userId: users.Olga, role: "STUDENT" },
      { lessonId: oTue.id, reason: null },
      NOW,
    );
    expect(olga).toMatchObject({ status: "reported", lessonCancelled: true });
    if (olga.status !== "reported") return;
    const adHoc = (startsAt: string, minutes: number) =>
      client.lesson.create({
        data: {
          schoolId,
          termId: ids.term,
          groupId: ids.oneOnOne,
          teacherId: ids.tess,
          roomId: ids.booth,
          startsAt: new Date(startsAt),
          endsAt: new Date(new Date(startsAt).getTime() + minutes * 6e4),
        },
      });
    // Thu 29 Oct 10:00, when Tom teaches group B: blocking for Tom.
    const clash = await adHoc("2026-10-29T09:00:00Z", 45);
    const friday = await adHoc("2026-10-30T15:00:00Z", 45);

    const request = edit("o", oSlot({ teacherId: ids.tom }), "2026-10-21");
    const conflicts = await validateSlot(db, request, NOW);
    expect(conflicts).toEqual([
      expect.objectContaining({
        type: "TEACHER_DOUBLE_BOOKED",
        severity: "blocking",
        key: expect.stringMatching(new RegExp(`^lesson:${clash.id}\\|`)),
      }),
    ]);
    expect(await saveSlot(db, admin, request, NOW)).toMatchObject({
      ok: false,
      reason: "BLOCKING_CONFLICTS",
    });
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: oTue.id } }),
    ).toMatchObject({ timetableSlotId: oldSlot });

    await client.lesson.delete({ where: { id: clash.id } });
    const result = await saveSlot(db, admin, request, NOW);
    if (!result.ok) throw new Error(JSON.stringify(result));
    slots.o = result.slotId;

    // The cancelled lesson moves but stays cancelled: no second lesson
    // comes back for 27 Oct, now or after regenerating.
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: oTue.id } }),
    ).toMatchObject({
      timetableSlotId: result.slotId,
      status: "CANCELLED",
      cancelReason: "STUDENT_CANCELLED",
      teacherId: ids.tess,
    });
    expect(
      await client.absenceReport.findUniqueOrThrow({
        where: { id: olga.absenceId },
      }),
    ).toMatchObject({ lessonId: oTue.id });
    expect(
      await client.makeupCredit.findUniqueOrThrow({
        where: { id: olga.credit!.id },
      }),
    ).toMatchObject({ sourceLessonId: oTue.id });
    await regenerateLessons(db, admin, ids.term, NOW);
    const onTue27 = await client.lesson.findMany({
      where: {
        groupId: ids.oneOnOne,
        startsAt: {
          gte: new Date("2026-10-26T23:00:00Z"),
          lt: new Date("2026-10-27T23:00:00Z"),
        },
      },
    });
    expect(onTue27.map((l) => [l.id, l.status])).toEqual([
      [oTue.id, "CANCELLED"],
    ]);
    // Later weeks and the group's ad-hoc lesson get Tom; today's doesn't.
    expect(await lessonOn(result.slotId, "2026-11-03")).toMatchObject({
      teacherId: ids.tom,
      status: "SCHEDULED",
    });
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: friday.id } }),
    ).toMatchObject({ teacherId: ids.tom });
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: oToday.id } }),
    ).toMatchObject({ timetableSlotId: oldSlot, teacherId: ids.tess });
  });

  it("keeps the split path when more than the teacher changes", async () => {
    const result = await saveSlot(
      db,
      admin,
      edit(
        "g",
        gSlot({ teacherId: ids.tess, roomId: ids.small }),
        "2026-11-23",
      ),
      NOW,
    );
    if (!result.ok) throw new Error(JSON.stringify(result));
    const audit = await client.auditLog.findFirstOrThrow({
      where: { schoolId, action: "timetable_slot.updated", entityId: slots.g },
    });
    expect(audit.data).toMatchObject({ mode: "split" });
    expect(result.lessons.moved).toBeUndefined();
  });
});
