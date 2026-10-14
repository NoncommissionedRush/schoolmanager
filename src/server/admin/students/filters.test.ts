import { describe, expect, it } from "vitest";

import {
  CURRENT_MEMBERSHIP,
  isUuid,
  NONE,
  parseStudentFilters,
  studentWhere,
} from "./filters";

const LEVEL = "6f1d3c1e-2b8a-4f5e-9c47-0a9e1d2b7c55";
const GROUP = "0b6f3c4e-1d2a-5b3c-8d4e-5f6a7b8c9d0e";

describe("parseStudentFilters", () => {
  it("accepts ids and the 'none' options, drops anything else", () => {
    expect(
      parseStudentFilters({ level: NONE, group: GROUP, q: " anna " }),
    ).toMatchObject({ level: NONE, group: GROUP, q: "anna", status: "active" });
    expect(
      parseStudentFilters({ level: "B1'; drop", group: "" }),
    ).toMatchObject({ level: null, group: null });
  });

  it("checks route ids", () => {
    expect(isUuid(LEVEL)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});

describe("studentWhere", () => {
  const filters = parseStudentFilters({});

  it("lists active students by default", () => {
    expect(studentWhere(filters)).toEqual({
      AND: [{ user: { deletedAt: null } }],
    });
    expect(studentWhere({ ...filters, status: "all" })).toEqual({});
  });

  it("filters by level, including 'No level'", () => {
    expect(studentWhere({ ...filters, level: LEVEL }).AND).toContainEqual({
      levelId: LEVEL,
    });
    expect(studentWhere({ ...filters, level: NONE }).AND).toContainEqual({
      levelId: null,
    });
  });

  it("filters by group, including 'Not in any group'", () => {
    expect(studentWhere({ ...filters, group: GROUP }).AND).toContainEqual({
      groupMemberships: { some: { groupId: GROUP, leftAt: null } },
    });
    expect(studentWhere({ ...filters, group: NONE }).AND).toContainEqual({
      groupMemberships: { none: CURRENT_MEMBERSHIP },
    });
  });

  it("searches name, email and phone", () => {
    expect(studentWhere({ ...filters, q: "777" }).AND).toContainEqual({
      OR: [
        { user: { name: { contains: "777", mode: "insensitive" } } },
        { user: { email: { contains: "777", mode: "insensitive" } } },
        { phone: { contains: "777", mode: "insensitive" } },
      ],
    });
  });
});
