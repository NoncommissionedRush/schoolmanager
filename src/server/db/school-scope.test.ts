import { describe, expect, it } from "vitest";

import {
  CrossSchoolAccessError,
  scopeArgs,
  TENANT_MODELS,
} from "./school-scope";

const SCHOOL = "school-a";
const OTHER = "school-b";

describe("TENANT_MODELS", () => {
  it("contains the models with a school_id", () => {
    for (const model of ["Membership", "Lesson", "TeacherNote", "AuditLog"]) {
      expect(TENANT_MODELS.has(model)).toBe(true);
    }
  });

  it("excludes global models", () => {
    for (const model of ["School", "User", "Account", "VerificationToken"]) {
      expect(TENANT_MODELS.has(model)).toBe(false);
    }
  });
});

describe("scopeArgs — tenant models", () => {
  it.each([
    "findMany",
    "findFirst",
    "count",
    "aggregate",
    "groupBy",
    "deleteMany",
  ])("adds the school to %s", (operation) => {
    expect(
      scopeArgs(
        "Lesson",
        operation,
        { where: { status: "SCHEDULED" } },
        SCHOOL,
      ),
    ).toEqual({ where: { status: "SCHEDULED", schoolId: SCHOOL } });
  });

  it("scopes queries without a where clause", () => {
    expect(scopeArgs("Group", "findMany", undefined, SCHOOL)).toEqual({
      where: { schoolId: SCHOOL },
    });
  });

  it("keeps unique lookups unique and scoped", () => {
    expect(
      scopeArgs("TeacherNote", "findUnique", { where: { id: "n1" } }, SCHOOL),
    ).toEqual({ where: { id: "n1", schoolId: SCHOOL } });
  });

  it("blocks an explicit other school", () => {
    expect(() =>
      scopeArgs("Lesson", "findMany", { where: { schoolId: OTHER } }, SCHOOL),
    ).toThrow(CrossSchoolAccessError);
  });

  it("blocks another school inside a composite unique key", () => {
    expect(() =>
      scopeArgs(
        "Membership",
        "findUnique",
        { where: { schoolId_userId: { schoolId: OTHER, userId: "u1" } } },
        SCHOOL,
      ),
    ).toThrow(CrossSchoolAccessError);
  });

  it("sets the school on create", () => {
    expect(
      scopeArgs("Room", "create", { data: { name: "R1" } }, SCHOOL),
    ).toEqual({ data: { name: "R1", schoolId: SCHOOL } });
  });

  it("sets the school on every row of createMany", () => {
    expect(
      scopeArgs(
        "Room",
        "createMany",
        { data: [{ name: "R1" }, { name: "R2" }] },
        SCHOOL,
      ),
    ).toEqual({
      data: [
        { name: "R1", schoolId: SCHOOL },
        { name: "R2", schoolId: SCHOOL },
      ],
    });
  });

  it("refuses to create rows for another school", () => {
    expect(() =>
      scopeArgs(
        "Room",
        "create",
        { data: { name: "R1", schoolId: OTHER } },
        SCHOOL,
      ),
    ).toThrow(CrossSchoolAccessError);
  });

  it("refuses relation writes to a school", () => {
    expect(() =>
      scopeArgs(
        "Room",
        "create",
        { data: { name: "R1", school: { connect: { id: OTHER } } } },
        SCHOOL,
      ),
    ).toThrow(CrossSchoolAccessError);
  });

  it("refuses to move rows to another school on update", () => {
    expect(() =>
      scopeArgs(
        "Room",
        "update",
        { where: { id: "r1" }, data: { schoolId: OTHER } },
        SCHOOL,
      ),
    ).toThrow(CrossSchoolAccessError);
  });

  it("scopes upserts on all sides", () => {
    expect(
      scopeArgs(
        "Level",
        "upsert",
        { where: { id: "l1" }, create: { code: "A1" }, update: { name: "x" } },
        SCHOOL,
      ),
    ).toEqual({
      where: { id: "l1", schoolId: SCHOOL },
      create: { code: "A1", schoolId: SCHOOL },
      update: { name: "x" },
    });
  });

  it("does not mutate the caller's arguments", () => {
    const args = { where: { id: "x" } };
    scopeArgs("Lesson", "findMany", args, SCHOOL);
    expect(args).toEqual({ where: { id: "x" } });
  });
});

describe("scopeArgs — global models", () => {
  it("pins School reads to the current school", () => {
    expect(scopeArgs("School", "findFirst", undefined, SCHOOL)).toEqual({
      where: { id: SCHOOL },
    });
  });

  it("blocks reading another school", () => {
    expect(() =>
      scopeArgs("School", "findUnique", { where: { id: OTHER } }, SCHOOL),
    ).toThrow(CrossSchoolAccessError);
  });

  it("only shows users that belong to the current school", () => {
    expect(
      scopeArgs("User", "findMany", { where: { AND: { name: "x" } } }, SCHOOL),
    ).toEqual({
      where: {
        AND: [{ name: "x" }, { memberships: { some: { schoolId: SCHOOL } } }],
      },
    });
  });

  it.each([
    ["User", "update"],
    ["User", "create"],
    ["School", "create"],
    ["School", "delete"],
    ["Account", "findMany"],
    ["VerificationToken", "findFirst"],
  ])("blocks %s.%s on the scoped client", (model, operation) => {
    expect(() => scopeArgs(model, operation, {}, SCHOOL)).toThrow(
      CrossSchoolAccessError,
    );
  });
});
