// Integration tests of the admin services against a real Postgres.
// Opt-in, like the timetable service tests: set SCHEDULING_TEST_DATABASE_URL
// to a migrated database (never your dev database; the tests create and
// delete their own schools), e.g.
//   SCHEDULING_TEST_DATABASE_URL=postgresql://…/schoolmanager_test pnpm test

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { createPgAdapter } from "@/lib/pg-adapter";
import { verifyPassword } from "@/server/auth/password";
import { scopeToSchool } from "@/server/db/school-scope";
import { fromIsoDate } from "@/server/scheduling";

import {
  archivePerson,
  createPerson,
  restorePerson,
  setPassword,
  updatePersonIdentity,
} from "./people/service";
import { AdminError } from "./result";
import {
  archiveRoom,
  createRoom,
  deleteRoom,
  updateRoom,
} from "./rooms/service";
import type { Scope } from "./shared";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
const TODAY = fromIsoDate("2026-10-20");

async function refusal(promise: Promise<unknown>): Promise<AdminError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AdminError) return error;
    throw error;
  }
  throw new Error("expected the service to refuse");
}

describe.skipIf(!url)("admin services (database)", () => {
  let client: PrismaClient;
  let scope: Scope;
  let other: Scope;
  const suffix = randomUUID().slice(0, 8);
  const mail = (name: string) => `${name}-${suffix}@example.test`;
  const ids = { term: randomUUID(), level: randomUUID(), group: randomUUID() };
  let adminId: string;

  const newSchool = async (name: string) => {
    const school = await client.school.create({
      data: {
        name,
        slug: `${name}-${suffix}`.toLowerCase().replace(/\s/g, "-"),
      },
    });
    const admin = await client.user.create({
      data: {
        name: `${name} Admin`,
        email: mail(`${name}-admin`.toLowerCase()),
      },
    });
    await client.membership.create({
      data: { schoolId: school.id, userId: admin.id, role: "ADMIN" },
    });
    return {
      db: scopeToSchool(client, school.id),
      schoolId: school.id,
      actor: { userId: admin.id },
    };
  };

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: createPgAdapter(url),
    });
    scope = await newSchool("Admin A");
    other = await newSchool("Admin B");
    adminId = scope.actor.userId;
    const { schoolId } = scope;
    await client.term.create({
      data: {
        id: ids.term,
        schoolId,
        name: "Autumn",
        startDate: fromIsoDate("2026-09-01"),
        endDate: fromIsoDate("2026-12-20"),
      },
    });
    await client.level.create({
      data: { id: ids.level, schoolId, code: "B1", name: "B1", rank: 1 },
    });
    await client.group.create({
      data: {
        id: ids.group,
        schoolId,
        levelId: ids.level,
        type: "GROUP",
        name: "B1 Mornings",
        capacity: 8,
      },
    });
  });

  afterAll(async () => {
    if (!client) return;
    for (const { schoolId } of [scope, other]) {
      await client.school.delete({ where: { id: schoolId } });
    }
    await client.user.deleteMany({
      where: { email: { endsWith: `${suffix}@example.test` } },
    });
    await client.$disconnect();
  });

  const teacher = (name: string) =>
    createPerson(
      scope,
      "TEACHER",
      { name, email: mail(name.toLowerCase()), password: "correct-horse" },
      (tx, userId) =>
        tx.teacherProfile.create({
          data: { schoolId: scope.schoolId, userId },
        }),
      client,
    );

  describe("people", () => {
    it("creates user, membership and profile, and audits without the password", async () => {
      const userId = await teacher("Tina");
      const membership = await client.membership.findUniqueOrThrow({
        where: { schoolId_userId: { schoolId: scope.schoolId, userId } },
        include: { user: true },
      });
      expect(membership.role).toBe("TEACHER");
      expect(membership.user.email).toBe(mail("tina"));
      expect(
        await verifyPassword("correct-horse", membership.user.passwordHash!),
      ).toBe(true);
      expect(
        await client.teacherProfile.count({
          where: { schoolId: scope.schoolId, userId },
        }),
      ).toBe(1);
      const audit = await client.auditLog.findMany({
        where: { entityId: userId },
      });
      expect(audit.map((row) => row.action).sort()).toEqual([
        "user.created",
        "user.password_set",
      ]);
      expect(JSON.stringify(audit)).not.toContain("correct-horse");
    });

    it("rejects a taken email, and points to an archived account", async () => {
      const userId = await teacher("Theo");
      const taken = await refusal(
        createPerson(
          scope,
          "STUDENT",
          { name: "X", email: mail("theo"), password: "0123456789" },
          undefined,
          client,
        ),
      );
      expect(taken).toMatchObject({
        field: "email",
        error: { key: "people.error.emailTaken" },
      });

      await archivePerson(scope, userId, TODAY, client);
      const archived = await refusal(
        createPerson(
          scope,
          "STUDENT",
          { name: "X", email: mail("theo"), password: "0123456789" },
          undefined,
          client,
        ),
      );
      expect(archived.error).toEqual({
        key: "people.error.emailArchived",
        values: { name: "Theo" },
      });

      // Used in another school: "already used" too (one school per user).
      const elsewhere = await refusal(
        createPerson(
          other,
          "STUDENT",
          { name: "X", email: mail("theo"), password: "0123456789" },
          undefined,
          client,
        ),
      );
      expect(elsewhere.error.key).toBe("people.error.emailTaken");
    });

    it("allows at most one membership per user in the database", async () => {
      const userId = await teacher("Una");
      await expect(
        client.membership.create({
          data: { schoolId: other.schoolId, userId, role: "STUDENT" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
      expect(await client.membership.count({ where: { userId } })).toBe(1);
    });

    it("sets passwords only for members of the school", async () => {
      const userId = await teacher("Pia");
      await setPassword(scope, userId, "a-new-password", client);
      const user = await client.user.findUniqueOrThrow({
        where: { id: userId },
      });
      expect(await verifyPassword("a-new-password", user.passwordHash!)).toBe(
        true,
      );

      const foreign = await refusal(
        setPassword(other, userId, "hijacked-password", client),
      );
      expect(foreign.error.key).toBe("common.error.notFound");
      const foreignEdit = await refusal(
        updatePersonIdentity(
          other,
          userId,
          { name: "X", email: mail("x") },
          client,
        ),
      );
      expect(foreignEdit.error.key).toBe("common.error.notFound");
    });

    it("blocks archiving a teacher who still has running slots", async () => {
      const userId = await teacher("Sam");
      const profile = await client.teacherProfile.findFirstOrThrow({
        where: { userId },
      });
      await client.timetableSlot.create({
        data: {
          schoolId: scope.schoolId,
          termId: ids.term,
          groupId: ids.group,
          teacherId: profile.id,
          weekday: 2,
          startMinute: 9 * 60,
          endMinute: 10 * 60,
        },
      });
      const blocked = await refusal(
        archivePerson(scope, userId, TODAY, client),
      );
      expect(blocked.blocked?.reason).toEqual({
        key: "teachers.blocked.hasSlots",
        values: { name: "Sam", count: 1 },
      });
      expect(blocked.blocked?.items).toEqual([
        {
          key: "teachers.blocked.slotItem",
          values: {
            group: "B1 Mornings",
            weekday: { key: "common.weekdayShort.2" },
            time: "09:00",
          },
        },
      ]);

      // A slot that ended before today no longer blocks.
      await client.timetableSlot.updateMany({
        where: { teacherId: profile.id },
        data: { validUntil: fromIsoDate("2026-10-19") },
      });
      await archivePerson(scope, userId, TODAY, client);
      expect(
        (await client.user.findUniqueOrThrow({ where: { id: userId } }))
          .deletedAt,
      ).not.toBeNull();
      await restorePerson(scope, userId, client);
      expect(
        (await client.user.findUniqueOrThrow({ where: { id: userId } }))
          .deletedAt,
      ).toBeNull();
    });

    it("takes an archived student out of their groups, keeping history", async () => {
      const userId = await createPerson(
        scope,
        "STUDENT",
        { name: "Stella", email: mail("stella"), password: "0123456789" },
        (tx, id) =>
          tx.studentProfile.create({
            data: { schoolId: scope.schoolId, userId: id },
          }),
        client,
      );
      const student = await client.studentProfile.findFirstOrThrow({
        where: { userId },
      });
      await client.groupMembership.create({
        data: {
          schoolId: scope.schoolId,
          groupId: ids.group,
          studentId: student.id,
        },
      });
      const result = await archivePerson(scope, userId, TODAY, client);
      expect(result.leftGroups).toEqual(["B1 Mornings"]);
      const membership = await client.groupMembership.findFirstOrThrow({
        where: { studentId: student.id },
      });
      expect(membership.leftAt).toEqual(TODAY);
    });

    it("never archives yourself or the last admin", async () => {
      const self = await refusal(archivePerson(scope, adminId, TODAY, client));
      expect(self.error.key).toBe("admins.error.self");

      const secondId = await createPerson(
        scope,
        "ADMIN",
        { name: "Second", email: mail("second"), password: "0123456789" },
        undefined,
        client,
      );
      // As the second admin, the first one can be archived …
      const asSecond = { ...scope, actor: { userId: secondId } };
      await archivePerson(asSecond, adminId, TODAY, client);
      // … but then the second is the last active admin.
      const last = await refusal(archivePerson(scope, secondId, TODAY, client));
      expect(last.error.key).toBe("admins.error.lastAdmin");
      await restorePerson(scope, adminId, client);
    });
  });

  describe("rooms", () => {
    it("keeps names unique case-insensitively", async () => {
      await createRoom(scope, {
        name: "Room 7",
        kind: "PHYSICAL",
        capacity: 10,
        meetingUrl: null,
      });
      const clash = await refusal(
        createRoom(scope, {
          name: "room 7",
          kind: "PHYSICAL",
          capacity: 10,
          meetingUrl: null,
        }),
      );
      expect(clash).toMatchObject({
        field: "name",
        error: { key: "validation.unique" },
      });
      // Another school may use the same name.
      await createRoom(other, {
        name: "Room 7",
        kind: "PHYSICAL",
        capacity: 10,
        meetingUrl: null,
      });
    });

    it("deletes only unused rooms; archiving is always allowed", async () => {
      const room = await createRoom(scope, {
        name: "Lab",
        kind: "PHYSICAL",
        capacity: 10,
        meetingUrl: null,
      });
      const profile = await client.teacherProfile.findFirstOrThrow({
        where: { schoolId: scope.schoolId },
      });
      await client.timetableSlot.create({
        data: {
          schoolId: scope.schoolId,
          termId: ids.term,
          groupId: ids.group,
          teacherId: profile.id,
          roomId: room.id,
          weekday: 4,
          startMinute: 9 * 60,
          endMinute: 10 * 60,
        },
      });
      const inUse = await refusal(deleteRoom(scope, room.id));
      expect(inUse.blocked?.reason).toEqual({
        key: "common.inUse",
        values: { count: 1 },
      });
      await archiveRoom(scope, room.id);
      const archived = await client.room.findUniqueOrThrow({
        where: { id: room.id },
      });
      expect(archived.archivedAt).not.toBeNull();
    });

    it("can't touch another school's room", async () => {
      const room = await createRoom(other, {
        name: "Foreign",
        kind: "ONLINE",
        capacity: null,
        meetingUrl: null,
      });
      for (const attempt of [
        () =>
          updateRoom(scope, room.id, {
            name: "Mine",
            kind: "ONLINE",
            capacity: null,
            meetingUrl: null,
          }),
        () => archiveRoom(scope, room.id),
        () => deleteRoom(scope, room.id),
      ]) {
        expect((await refusal(attempt())).error.key).toBe(
          "common.error.notFound",
        );
      }
    });
  });
});
