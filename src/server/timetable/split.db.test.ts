// Slot splits carry absences, cancelled 1-on-1s and replacement bookings over
// to the successor lesson (docs/architecture/replacements.md §5 _Slot
// splits_), against a real Postgres. Opt-in, like the other DB tests: set
// SCHEDULING_TEST_DATABASE_URL to a migrated database (never your dev
// database; the test creates and deletes its own school).

import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
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
} from "./service";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
// Tue 20 Oct 2026, 12:00 in Bratislava; the default cutoff is 24 hours.
const NOW = new Date("2026-10-20T10:00:00Z");

describe.skipIf(!url)("slot splits (database)", () => {
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

  async function editSlot(
    key: "g" | "o",
    slot: SlotInput,
    effectiveFrom = "2026-10-21",
  ) {
    const result = await saveSlot(
      db,
      admin,
      { slotId: slots[key], slot, effectiveFrom },
      NOW,
    );
    if (!result.ok) throw new Error(JSON.stringify(result));
    slots[key] = result.slotId;
    return result;
  }

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
      adapter: new PrismaPg({ connectionString: url }),
    });
    const suffix = randomUUID().slice(0, 8);
    const school = await client.school.create({
      data: { name: `Split ${suffix}`, slug: `split-${suffix}` },
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

  it("moves absences and bookings to the successor, or releases what can't follow", async () => {
    const gMon = (await lessonOn(slots.g, "2026-10-26"))!;
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
    const booked = await bookReplacement(
      db,
      { userId: users.Eve },
      { creditId: eve.credit!.id, targetLessonId: gMon.id },
      NOW,
    );
    expect(booked).toMatchObject({ status: "booked" });
    const booking = await client.replacementRequest.findFirstOrThrow({
      where: { studentId: ids.eve },
    });

    // Monday → Wednesday: the Wed 28 Oct lesson takes Mon 26 Oct's place.
    const toWed = await editSlot("g", gSlot({ weekday: 3 }));
    const gWed = (await lessonOn(slots.g, "2026-10-28"))!;
    expect(toWed).toMatchObject({ ok: true, endedSlotId: expect.any(String) });
    expect(
      await client.absenceReport.findUniqueOrThrow({
        where: { id: cara.absenceId },
      }),
    ).toMatchObject({ lessonId: gWed.id });
    expect(
      await client.makeupCredit.findUniqueOrThrow({
        where: { id: cara.credit!.id },
      }),
    ).toMatchObject({ sourceLessonId: gWed.id, status: "AVAILABLE" });
    expect(
      await client.replacementRequest.findUniqueOrThrow({
        where: { id: booking.id },
      }),
    ).toMatchObject({ targetLessonId: gWed.id, status: "AUTO_APPROVED" });
    // Nothing refers to the old Monday lesson any more: it is gone.
    expect(await client.lesson.findUnique({ where: { id: gMon.id } })).toBe(
      null,
    );
    expect(
      await client.auditLog.findFirst({
        where: { schoolId, action: "replacement.moved", entityId: booking.id },
      }),
    ).toMatchObject({
      data: { previousTargetLessonId: gMon.id, targetLessonId: gWed.id },
    });

    // Wednesday → Thursday 10:00, when Eve has her own group: her booking
    // can't follow (STUDENT_CLASH), so it is released with grace; Cara's
    // absence still moves.
    await editSlot(
      "g",
      gSlot({ weekday: 4, startMinute: 600, endMinute: 690 }),
    );
    const gThu = (await lessonOn(slots.g, "2026-10-29"))!;
    expect(
      await client.absenceReport.findUniqueOrThrow({
        where: { id: cara.absenceId },
      }),
    ).toMatchObject({ lessonId: gThu.id });
    expect(
      await client.replacementRequest.findUniqueOrThrow({
        where: { id: booking.id },
      }),
    ).toMatchObject({
      targetLessonId: gWed.id,
      status: "CANCELLED",
      cancelReason: "LESSON_CANCELLED",
    });
    expect(
      await client.makeupCredit.findUniqueOrThrow({
        where: { id: eve.credit!.id },
      }),
    ).toMatchObject({ status: "AVAILABLE" });
    // The released booking is history of the Wednesday lesson: cancelled.
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: gWed.id } }),
    ).toMatchObject({ status: "CANCELLED", cancelReason: "TIMETABLE_CHANGED" });
  });

  it("creates the successor of a student-cancelled 1-on-1 already cancelled", async () => {
    const oTue = (await lessonOn(slots.o, "2026-10-27"))!;
    const olga = await reportAbsence(
      db,
      { userId: users.Olga, role: "STUDENT" },
      { lessonId: oTue.id, reason: null },
      NOW,
    );
    expect(olga).toMatchObject({ status: "reported", lessonCancelled: true });
    if (olga.status !== "reported") return;

    await editSlot("o", oSlot({ weekday: 5 }));
    const oFri = (await lessonOn(slots.o, "2026-10-30"))!;
    expect(oFri).toMatchObject({
      status: "CANCELLED",
      cancelReason: "STUDENT_CANCELLED",
    });
    expect(
      await client.absenceReport.findUniqueOrThrow({
        where: { id: olga.absenceId },
      }),
    ).toMatchObject({ lessonId: oFri.id });
    expect(
      await client.makeupCredit.findUniqueOrThrow({
        where: { id: olga.credit!.id },
      }),
    ).toMatchObject({ sourceLessonId: oFri.id });
    // Every other week is scheduled as usual, and regenerating keeps it so.
    expect(await lessonOn(slots.o, "2026-11-06")).toMatchObject({
      status: "SCHEDULED",
    });
    await regenerateLessons(db, admin, ids.term, NOW);
    expect(
      await client.lesson.findUniqueOrThrow({ where: { id: oFri.id } }),
    ).toMatchObject({ status: "CANCELLED" });
  });
});
