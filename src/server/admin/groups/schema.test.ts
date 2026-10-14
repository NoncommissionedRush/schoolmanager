import { describe, expect, it } from "vitest";

import { courseSchema } from "../courses/schema";
import { parseInput } from "../validation";
import {
  addMembersSchema,
  addToGroupSchema,
  groupSchema,
  removeMemberSchema,
} from "./schema";

const LEVEL = "6f1d3c1e-2b8a-4f5e-9c47-0a9e1d2b7c55";
const STUDENT = "0b6f3c4e-1d2a-5b3c-8d4e-5f6a7b8c9d0e";

describe("groupSchema", () => {
  const base = { name: "B1 Evening", levelId: LEVEL, courseId: "" };

  it("requires a capacity of 1–100 for group lessons", () => {
    expect(
      parseInput(groupSchema, { ...base, type: "GROUP", capacity: "" }),
    ).toEqual({
      ok: false,
      fieldErrors: {
        capacity: {
          key: "validation.integerRange",
          values: { min: 1, max: 100 },
        },
      },
    });
    expect(
      parseInput(groupSchema, { ...base, type: "GROUP", capacity: "101" }).ok,
    ).toBe(false);
    expect(
      parseInput(groupSchema, { ...base, type: "GROUP", capacity: "0" }).ok,
    ).toBe(false);
    const parsed = parseInput(groupSchema, {
      ...base,
      type: "GROUP",
      capacity: "10",
      studentId: STUDENT,
    });
    expect(parsed).toMatchObject({
      ok: true,
      data: { capacity: 10, courseId: null, studentId: null },
    });
  });

  it("fixes a 1-on-1's capacity at 1 and keeps its student", () => {
    expect(
      parseInput(groupSchema, {
        ...base,
        type: "ONE_ON_ONE",
        capacity: "8",
        studentId: STUDENT,
      }),
    ).toMatchObject({ ok: true, data: { capacity: 1, studentId: STUDENT } });
    expect(
      parseInput(groupSchema, { ...base, type: "ONE_ON_ONE", capacity: "" }),
    ).toMatchObject({ ok: true, data: { capacity: 1, studentId: null } });
  });

  it("requires a name, a level and a type", () => {
    const result = parseInput(groupSchema, { name: " ", capacity: "5" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual([
      "levelId",
      "name",
      "type",
    ]);
    expect(result.fieldErrors.levelId).toEqual({
      key: "validation.select",
      values: { field: { key: "groups.field.level" } },
    });
  });
});

describe("membership schemas", () => {
  it("needs at least one student and a start date", () => {
    expect(parseInput(addMembersSchema, { startDate: "2026-10-14" })).toEqual({
      ok: false,
      fieldErrors: { studentIds: { key: "groups.members.noneSelected" } },
    });
    expect(
      parseInput(addMembersSchema, {
        studentIds: STUDENT,
        startDate: "2026-10-14",
      }),
    ).toEqual({
      ok: true,
      data: { studentIds: [STUDENT], startDate: "2026-10-14" },
    });
    expect(
      parseInput(addMembersSchema, {
        studentIds: [STUDENT],
        startDate: "2026-02-30",
      }).ok,
    ).toBe(false);
  });

  it("validates the group picker and the last day", () => {
    expect(
      parseInput(addToGroupSchema, { groupId: "", startDate: "2026-10-14" }),
    ).toMatchObject({ ok: false, fieldErrors: { groupId: {} } });
    expect(parseInput(removeMemberSchema, { date: "" }).ok).toBe(false);
    expect(parseInput(removeMemberSchema, { date: "2026-10-14" }).ok).toBe(
      true,
    );
  });
});

describe("courseSchema", () => {
  it("requires name and level; description is optional", () => {
    expect(
      parseInput(courseSchema, { name: "Exam prep", levelId: LEVEL }),
    ).toEqual({
      ok: true,
      data: { name: "Exam prep", levelId: LEVEL, description: null },
    });
    expect(parseInput(courseSchema, { name: "", levelId: "" }).ok).toBe(false);
  });
});
