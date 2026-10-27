// Availability change requests against a real Postgres
// (docs/design/availability-requests.md). Opt-in, like the other DB tests:
// set SCHEDULING_TEST_DATABASE_URL to a migrated database (never your dev
// database; the test creates and deletes its own schools).

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { createPgAdapter } from "@/lib/pg-adapter";
import { AdminError } from "@/server/admin/result";
import type { Scope } from "@/server/admin/shared";
import { scopeToSchool } from "@/server/db/school-scope";
import type { SchoolDb } from "@/server/timetable/service";

import {
  approveRequest,
  listRequests,
  pendingCounts,
  rejectRequest,
  requestDelete,
  requestException,
  requestWeekly,
  withdrawRequest,
} from "./service";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
const TZ = "Europe/Bratislava";
// Mon 19 Oct 2026, 12:00 UTC.
const NOW = new Date("2026-10-19T12:00:00Z");

const weekly = (
  weekdays: number[],
  startMinute: number,
  endMinute: number,
) => ({
  weekdays,
  startMinute,
  endMinute,
  note: null,
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AdminError) return error.error.key;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe.skipIf(!url)("availability requests (database)", () => {
  const suffix = randomUUID().slice(0, 8);
  let client: PrismaClient;
  let db: SchoolDb;
  let otherDb: SchoolDb;
  let schoolId: string;
  let otherSchoolId: string;
  const schools: string[] = [];
  const user: Record<string, string> = {};
  const ids = { tomas: randomUUID(), ana: randomUUID(), foreign: randomUUID() };
  let teacherScope: Scope;
  let anaScope: Scope;
  let adminScope: Scope;

  const rules = () =>
    client.teacherAvailability.findMany({
      where: { teacherId: ids.tomas },
      orderBy: [{ weekday: "asc" }, { date: "asc" }],
    });
  const notifications = (recipientId: string) =>
    client.notification.findMany({ where: { schoolId, recipientId } });

  beforeAll(async () => {
    client = new PrismaClient({ adapter: createPgAdapter(url!) });
    const school = await client.school.create({
      data: { name: `Avr ${suffix}`, slug: `avr-${suffix}`, timezone: TZ },
    });
    const other = await client.school.create({
      data: { name: `Avr O ${suffix}`, slug: `avr-o-${suffix}`, timezone: TZ },
    });
    schools.push(school.id, other.id);
    schoolId = school.id;
    otherSchoolId = other.id;
    db = scopeToSchool(client, schoolId);
    otherDb = scopeToSchool(client, other.id);
    const person = async (
      name: string,
      role: "ADMIN" | "TEACHER",
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
    await client.teacherProfile.create({
      data: {
        id: ids.tomas,
        schoolId,
        userId: await person("Tomas", "TEACHER"),
      },
    });
    await client.teacherProfile.create({
      data: { id: ids.ana, schoolId, userId: await person("Ana", "TEACHER") },
    });
    await client.teacherProfile.create({
      data: {
        id: ids.foreign,
        schoolId: other.id,
        userId: await person("Olaf", "TEACHER", other.id),
      },
    });
    teacherScope = { db, schoolId, actor: { userId: user.Tomas } };
    anaScope = { db, schoolId, actor: { userId: user.Ana } };
    adminScope = { db, schoolId, actor: { userId: user.Admin } };
  });

  beforeEach(async () => {
    if (!client) return;
    await client.availabilityRequest.deleteMany({ where: { schoolId } });
    await client.teacherAvailability.deleteMany({ where: { schoolId } });
    await client.notification.deleteMany({ where: { schoolId } });
  });

  afterAll(async () => {
    if (!client) return;
    await client.school.deleteMany({ where: { id: { in: schools } } });
    await client.user.deleteMany({
      where: { email: { endsWith: `-${suffix}@example.test` } },
    });
    await client.$disconnect();
  });

  it("a request changes nothing until an admin approves it", async () => {
    const { id } = await requestWeekly(
      teacherScope,
      ids.tomas,
      weekly([1, 3], 540, 720),
      null,
      NOW,
    );
    expect(await rules()).toEqual([]);
    const listed = await listRequests(db, ids.tomas, NOW);
    expect(listed.pending).toMatchObject([
      { id, kind: "ADD_WEEKLY", status: "PENDING", targetId: null },
    ]);
    expect((await pendingCounts(db)).get(ids.tomas)).toBe(1);

    await approveRequest(adminScope, ids.tomas, id, TZ, NOW);
    expect(
      (await rules()).map((r) => [r.weekday, r.startMinute, r.endMinute]),
    ).toEqual([
      [1, 540, 720],
      [3, 540, 720],
    ]);
    const after = await listRequests(db, ids.tomas, NOW);
    expect(after.pending).toEqual([]);
    expect(after.recent).toMatchObject([{ id, status: "APPROVED" }]);
  });

  it("notifies every admin of a request and the teacher of the decision", async () => {
    const { id } = await requestException(
      teacherScope,
      ids.tomas,
      {
        kind: "DATE_UNAVAILABLE",
        dates: ["2026-10-22", "2026-10-23"],
        window: null,
        note: "Doctor",
      },
      TZ,
      NOW,
    );
    for (const admin of [user.Admin, user.Admin2]) {
      expect(await notifications(admin)).toMatchObject([
        {
          type: "AVAILABILITY_REQUEST_PENDING",
          params: { teacher: "Tomas", count: 1 },
          link: { kind: "availability", teacherId: ids.tomas },
        },
      ]);
    }
    await rejectRequest(adminScope, ids.tomas, id, "Exam week", NOW);
    expect(await rules()).toEqual([]);
    expect(await notifications(user.Tomas)).toMatchObject([
      {
        type: "AVAILABILITY_REQUEST_DECIDED",
        audience: "teacher",
        params: { outcome: "rejected", note: "Exam week" },
      },
    ]);
    const { recent } = await listRequests(db, ids.tomas, NOW);
    expect(recent).toMatchObject([
      { id, status: "REJECTED", reviewNote: "Exam week" },
    ]);
  });

  it("approving an exception creates one row per day", async () => {
    const { id } = await requestException(
      teacherScope,
      ids.tomas,
      {
        kind: "DATE_UNAVAILABLE",
        dates: ["2026-10-22", "2026-10-23"],
        window: { startMinute: 600, endMinute: 660 },
        note: null,
      },
      TZ,
      NOW,
    );
    expect(await approveRequest(adminScope, ids.tomas, id, TZ, NOW)).toEqual({
      affected: 0,
    });
    expect((await rules()).map((r) => r.kind)).toEqual([
      "DATE_UNAVAILABLE",
      "DATE_UNAVAILABLE",
    ]);
  });

  it("edits and deletes target one of the teacher's own rules", async () => {
    const rule = await client.teacherAvailability.create({
      data: {
        schoolId,
        teacherId: ids.tomas,
        kind: "WEEKLY_UNAVAILABLE",
        weekday: 2,
        startMinute: 480,
        endMinute: 600,
      },
    });
    const edit = await requestWeekly(
      teacherScope,
      ids.tomas,
      weekly([2], 480, 720),
      rule.id,
      NOW,
    );
    // One pending change per rule.
    expect(
      await refusal(requestDelete(teacherScope, ids.tomas, rule.id, NOW)),
    ).toBe("availabilityRequests.error.alreadyPending");
    // Another teacher's rule is "not found".
    expect(await refusal(requestDelete(anaScope, ids.ana, rule.id, NOW))).toBe(
      "common.error.notFound",
    );
    const { pending } = await listRequests(db, ids.tomas, NOW);
    expect(pending[0]).toMatchObject({
      kind: "EDIT_WEEKLY",
      targetId: rule.id,
      target: { weekday: 2, startMinute: 480, endMinute: 600 },
    });

    await approveRequest(adminScope, ids.tomas, edit.id, TZ, NOW);
    const [edited] = await rules();
    expect([edited.weekday, edited.startMinute, edited.endMinute]).toEqual([
      2, 480, 720,
    ]);

    const remove = await requestDelete(teacherScope, ids.tomas, edited.id, NOW);
    await approveRequest(adminScope, ids.tomas, remove.id, TZ, NOW);
    expect(await rules()).toEqual([]);
  });

  it("an edit whose rule is gone can't be approved and stays pending", async () => {
    const rule = await client.teacherAvailability.create({
      data: {
        schoolId,
        teacherId: ids.tomas,
        kind: "WEEKLY_UNAVAILABLE",
        weekday: 4,
        startMinute: 480,
        endMinute: 600,
      },
    });
    const edit = await requestWeekly(
      teacherScope,
      ids.tomas,
      weekly([4], 500, 600),
      rule.id,
      NOW,
    );
    await client.teacherAvailability.delete({ where: { id: rule.id } });
    expect(
      await refusal(approveRequest(adminScope, ids.tomas, edit.id, TZ, NOW)),
    ).toBe("availabilityRequests.error.targetGone");
    expect((await listRequests(db, ids.tomas, NOW)).pending).toMatchObject([
      { id: edit.id, status: "PENDING" },
    ]);
    const stored = await client.availabilityRequest.findUniqueOrThrow({
      where: { id: edit.id },
    });
    expect(stored.reviewedAt).toBeNull();
  });

  it("is decided once: a second approve, a reject or a withdraw is refused", async () => {
    const { id } = await requestWeekly(
      teacherScope,
      ids.tomas,
      weekly([5], 900, 960),
      null,
      NOW,
    );
    const results = await Promise.allSettled([
      approveRequest(adminScope, ids.tomas, id, TZ, NOW),
      approveRequest(
        { ...adminScope, actor: { userId: user.Admin2 } },
        ids.tomas,
        id,
        TZ,
        NOW,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await rules()).toHaveLength(1);
    expect(
      await refusal(rejectRequest(adminScope, ids.tomas, id, null, NOW)),
    ).toBe("availabilityRequests.error.alreadyDecided");
    expect(await refusal(withdrawRequest(teacherScope, ids.tomas, id))).toBe(
      "availabilityRequests.error.alreadyDecided",
    );
  });

  it("the teacher can withdraw their own pending request, not another's", async () => {
    const { id } = await requestWeekly(
      teacherScope,
      ids.tomas,
      weekly([1], 600, 660),
      null,
      NOW,
    );
    expect(await refusal(withdrawRequest(anaScope, ids.ana, id))).toBe(
      "common.error.notFound",
    );
    await withdrawRequest(teacherScope, ids.tomas, id);
    expect(await listRequests(db, ids.tomas, NOW)).toEqual({
      pending: [],
      recent: [],
    });
    expect(
      await refusal(approveRequest(adminScope, ids.tomas, id, TZ, NOW)),
    ).toBe("availabilityRequests.error.alreadyDecided");
  });

  it("refuses exceptions for days that have passed", async () => {
    expect(
      await refusal(
        requestException(
          teacherScope,
          ids.tomas,
          {
            kind: "DATE_UNAVAILABLE",
            dates: ["2026-10-18"],
            window: null,
            note: null,
          },
          TZ,
          NOW,
        ),
      ),
    ).toBe("availabilityRequests.error.pastDate");
  });

  it("an admin's detail page only reaches requests of that teacher and school", async () => {
    const { id } = await requestWeekly(
      teacherScope,
      ids.tomas,
      weekly([1], 600, 660),
      null,
      NOW,
    );
    expect(
      await refusal(approveRequest(adminScope, ids.ana, id, TZ, NOW)),
    ).toBe("common.error.notFound");
    const foreignAdmin: Scope = {
      db: otherDb,
      schoolId: otherSchoolId,
      actor: { userId: user.Admin },
    };
    expect(
      await refusal(approveRequest(foreignAdmin, ids.tomas, id, TZ, NOW)),
    ).toBe("common.error.notFound");
    expect(await listRequests(otherDb, ids.tomas, NOW)).toEqual({
      pending: [],
      recent: [],
    });
  });
});
