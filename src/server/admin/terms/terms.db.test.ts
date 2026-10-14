// A school's terms never overlap (CARM-60): the term service and the
// `terms_no_overlap` exclusion constraint, against a real Postgres. Opt-in
// like the other database tests: set SCHEDULING_TEST_DATABASE_URL to a
// migrated database (never your dev database).

import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { scopeToSchool } from "@/server/db/school-scope";
import { fromIsoDate } from "@/server/scheduling";

import { AdminError } from "../result";
import { isExclusionViolation, type Scope } from "../shared";
import { parseInput } from "../validation";
import { termSchema } from "./schema";
import { createTerm, termContext, updateTerm } from "./service";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;

async function refusal(promise: Promise<unknown>): Promise<AdminError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AdminError) return error;
    throw error;
  }
  throw new Error("expected the service to refuse");
}

describe.skipIf(!url)("terms don't overlap (database)", () => {
  let client: PrismaClient;
  let scope: Scope;
  let other: Scope;
  const suffix = randomUUID().slice(0, 8);
  const autumn = randomUUID();

  const newSchool = async (name: string): Promise<Scope> => {
    const school = await client.school.create({
      data: {
        name,
        slug: `${name}-${suffix}`.toLowerCase().replace(/\s/g, "-"),
      },
    });
    const admin = await client.user.create({
      data: {
        name: `${name} Admin`,
        email: `${name}-${suffix}@example.test`
          .toLowerCase()
          .replace(/\s/g, "-"),
      },
    });
    // A member: other tests' cleanup removes test users without one.
    await client.membership.create({
      data: { schoolId: school.id, userId: admin.id, role: "ADMIN" },
    });
    return {
      db: scopeToSchool(client, school.id),
      schoolId: school.id,
      actor: { userId: admin.id },
    };
  };

  const insert = (schoolId: string, name: string, start: string, end: string) =>
    client.term.create({
      data: {
        schoolId,
        name,
        startDate: fromIsoDate(start),
        endDate: fromIsoDate(end),
      },
    });

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    scope = await newSchool("Terms A");
    other = await newSchool("Terms B");
    await client.term.create({
      data: {
        id: autumn,
        schoolId: scope.schoolId,
        name: "Autumn",
        startDate: fromIsoDate("2026-09-01"),
        endDate: fromIsoDate("2027-01-30"),
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

  describe("constraint", () => {
    it("refuses a term sharing even one day with another", async () => {
      for (const [start, end] of [
        ["2027-01-30", "2027-06-30"], // starts on Autumn's last day
        ["2026-08-01", "2026-09-01"], // ends on Autumn's first day
        ["2026-10-01", "2026-10-31"], // inside
        ["2026-08-01", "2027-06-30"], // encloses
      ]) {
        const error = await insert(scope.schoolId, "Clash", start, end).then(
          () => null,
          (error: unknown) => error,
        );
        expect(isExclusionViolation(error, "terms_no_overlap")).toBe(true);
      }
    });

    it("allows back-to-back terms and the same dates in another school", async () => {
      const spring = await insert(
        scope.schoolId,
        "Spring",
        "2027-01-31",
        "2027-06-30",
      );
      await insert(other.schoolId, "Autumn", "2026-09-01", "2027-01-30");
      await client.term.delete({ where: { id: spring.id } });
    });

    it("refuses moving a term onto another one", async () => {
      const summer = await insert(
        scope.schoolId,
        "Summer",
        "2027-07-01",
        "2027-08-31",
      );
      const error = await client.term
        .update({
          where: { id: summer.id },
          data: { startDate: fromIsoDate("2027-01-15") },
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(isExclusionViolation(error, "terms_no_overlap")).toBe(true);
      await client.term.delete({ where: { id: summer.id } });
    });
  });

  describe("service", () => {
    const overlap = { key: "terms.error.overlap", values: { term: "Autumn" } };

    it("validates against the school's other terms", async () => {
      const context = await termContext(scope.db, null, "2026-10-14");
      expect(
        parseInput(termSchema(context), {
          name: "Spring",
          startDate: "2027-01-30",
          endDate: "2027-06-30",
        }),
      ).toEqual({ ok: false, fieldErrors: { startDate: overlap } });
      // Another school's terms don't count.
      const elsewhere = await termContext(other.db, null, "2026-10-14");
      expect(elsewhere.terms?.map((term) => term.id)).not.toContain(autumn);
    });

    it("reports a create the constraint refused as the overlap error", async () => {
      // As if another save got in after the schema check.
      const error = await refusal(
        createTerm(scope, {
          name: "Spring",
          startDate: "2027-01-30",
          endDate: "2027-06-30",
        }),
      );
      expect(error.error).toEqual(overlap);
      expect(error.field).toBe("startDate");
    });

    it("reports an update the constraint refused as the overlap error", async () => {
      const spring = await createTerm(scope, {
        name: "Spring",
        startDate: "2027-02-01",
        endDate: "2027-06-30",
      });
      const error = await refusal(
        updateTerm(scope, spring.id, {
          name: "Spring",
          startDate: "2027-01-01",
          endDate: "2027-06-30",
        }),
      );
      expect(error.error).toEqual(overlap);
      const stored = await client.term.findUniqueOrThrow({
        where: { id: spring.id },
      });
      expect(stored.startDate).toEqual(fromIsoDate("2027-02-01"));
    });
  });
});
