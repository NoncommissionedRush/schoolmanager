import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CrossSchoolAccessError,
  scopeArgs,
  TENANT_MODELS,
  USER_RELATION_FIELDS,
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

describe("scopeArgs — User relations span schools", () => {
  it("rejects including a user's memberships (other schools leak)", () => {
    expect(() =>
      scopeArgs(
        "User",
        "findUnique",
        {
          where: { id: "u1" },
          include: { memberships: { include: { school: true } } },
        },
        SCHOOL,
      ),
    ).toThrow(CrossSchoolAccessError);
  });

  it("rejects relation selects and _count on User", () => {
    for (const select of [
      { id: true, teacherProfiles: true },
      { id: true, _count: true },
    ]) {
      expect(() => scopeArgs("User", "findMany", { select }, SCHOOL)).toThrow(
        CrossSchoolAccessError,
      );
    }
  });

  it("rejects a User reached through a tenant model and back out", () => {
    expect(() =>
      scopeArgs(
        "School",
        "findFirst",
        {
          include: {
            memberships: {
              include: {
                user: {
                  include: { memberships: { include: { school: true } } },
                },
              },
            },
          },
        },
        SCHOOL,
      ),
    ).toThrow(CrossSchoolAccessError);
  });

  it("rejects nested User relations on writes' return values", () => {
    expect(() =>
      scopeArgs(
        "AuditLog",
        "create",
        {
          data: { action: "x" },
          select: { actor: { select: { studentProfiles: true } } },
        },
        SCHOOL,
      ),
    ).toThrow(CrossSchoolAccessError);
  });

  it("rejects relation filters on User", () => {
    expect(() =>
      scopeArgs(
        "User",
        "findMany",
        { where: { memberships: { some: { schoolId: OTHER } } } },
        SCHOOL,
      ),
    ).toThrow(CrossSchoolAccessError);
  });

  describe("relation filters are walked recursively", () => {
    const leaks: [string, string, Record<string, unknown>][] = [
      // QA follow-up on PR #5: both answered "is this user also in school B?"
      [
        "User",
        "count",
        { where: { AND: [{ memberships: { some: { schoolId: OTHER } } }] } },
      ],
      [
        "Membership",
        "count",
        { where: { user: { memberships: { some: { schoolId: OTHER } } } } },
      ],
      [
        "User",
        "findMany",
        { where: { OR: [{ name: "a" }, { teacherProfiles: { some: {} } }] } },
      ],
      [
        "User",
        "findFirst",
        { where: { NOT: { memberships: { none: { schoolId: OTHER } } } } },
      ],
      [
        "Membership",
        "findMany",
        { where: { user: { is: { studentProfiles: { some: {} } } } } },
      ],
      [
        "Lesson",
        "findMany",
        {
          where: {
            attendance: {
              some: {
                recordedBy: { memberships: { some: { schoolId: OTHER } } },
              },
            },
          },
        },
      ],
      [
        "Group",
        "findMany",
        {
          where: {
            AND: {
              memberships: {
                some: {
                  student: {
                    user: { OR: [{ memberships: { some: {} } }] },
                  },
                },
              },
            },
          },
        },
      ],
      [
        "Group",
        "findMany",
        {
          include: {
            memberships: {
              where: { student: { user: { accounts: { some: {} } } } },
            },
          },
        },
      ],
      [
        "Room",
        "findMany",
        {
          select: {
            _count: {
              select: {
                lessons: {
                  where: {
                    attendance: {
                      some: { recordedBy: { memberships: { some: {} } } },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    ];

    it.each(leaks)(
      "rejects %s.%s filtering through a User's relations",
      (model, operation, args) => {
        expect(() => scopeArgs(model, operation, args, SCHOOL)).toThrow(
          CrossSchoolAccessError,
        );
      },
    );

    it("allows scalar User filters at any depth", () => {
      for (const [model, args] of [
        [
          "User",
          {
            where: {
              AND: [{ email: { contains: "a" } }],
              NOT: { deletedAt: null },
            },
          },
        ],
        [
          "Membership",
          { where: { user: { email: "a@b.c", deletedAt: null } } },
        ],
        [
          "Membership",
          { where: { user: { is: { name: { startsWith: "A" } } } } },
        ],
        [
          "Group",
          {
            where: {
              memberships: {
                some: { leftAt: null, student: { user: { deletedAt: null } } },
              },
            },
          },
        ],
        [
          "StudentProfile",
          {
            where: {
              OR: [
                { user: { name: { contains: "x", mode: "insensitive" } } },
                { phone: { contains: "x" } },
              ],
              groupMemberships: { none: { leftAt: null } },
            },
          },
        ],
      ] as const) {
        expect(() =>
          scopeArgs(model, "findMany", args as Record<string, unknown>, SCHOOL),
        ).not.toThrow();
      }
    });
  });

  it("allows a User's scalar fields, directly and from the tenant side", () => {
    expect(
      scopeArgs(
        "User",
        "findMany",
        { where: { OR: [{ name: "a" }] }, select: { id: true, name: true } },
        SCHOOL,
      ),
    ).toMatchObject({ select: { id: true, name: true } });
    expect(
      scopeArgs(
        "Membership",
        "findMany",
        {
          include: {
            user: { select: { id: true, name: true, teacherProfiles: false } },
            school: true,
          },
        },
        SCHOOL,
      ),
    ).toMatchObject({ where: { schoolId: SCHOOL } });
    expect(() =>
      scopeArgs(
        "Lesson",
        "findMany",
        { include: { attendance: { include: { recordedBy: true } } } },
        SCHOOL,
      ),
    ).not.toThrow();
  });

  it("knows every relation field that points at User", () => {
    const schema = readFileSync(
      join(process.cwd(), "prisma/schema.prisma"),
      "utf8",
    );
    const relations = [
      ...schema.matchAll(/^\s+(\w+)\s+(\w+)(\[\])?\??\s+(@relation|$)/gm),
    ];
    const toUser = new Set(
      relations.filter(([, , type]) => type === "User").map(([, f]) => f),
    );
    expect(toUser).toEqual(new Set(USER_RELATION_FIELDS));
    // No relation to another model reuses one of those names.
    const models = new Set(
      [...schema.matchAll(/^model (\w+) \{/gm)].map(([, name]) => name),
    );
    for (const [, field, type] of relations) {
      if (USER_RELATION_FIELDS.has(field) && models.has(type)) {
        expect(type, field).toBe("User");
      }
    }
  });
});
