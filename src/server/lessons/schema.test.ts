import { describe, expect, it } from "vitest";

import { parseInput } from "@/server/admin/validation";

import {
  createNoteSchema,
  lessonLogSchema,
  parseAbout,
  updateNoteSchema,
} from "./schema";

const LESSON = "4b7f1f9e-3c1a-4a59-9d55-0b7c6f2f7a10";
const STUDENT = "9a0c2e4f-1b3d-4c5e-8f70-123456789abc";

describe("lessonLogSchema", () => {
  it("trims both texts, keeps inner line breaks, empty → null", () => {
    const parsed = parseInput(lessonLogSchema, {
      lessonId: LESSON,
      content: "  Unit 4\nspeaking  ",
      homework: "   ",
      expectedUpdatedAt: "",
    });
    expect(parsed).toEqual({
      ok: true,
      data: {
        lessonId: LESSON,
        content: "Unit 4\nspeaking",
        homework: null,
        expectedUpdatedAt: null,
      },
    });
  });

  it("enforces covered ≤ 5,000 and homework ≤ 2,000", () => {
    const parsed = parseInput(lessonLogSchema, {
      lessonId: LESSON,
      content: "x".repeat(5001),
      homework: "y".repeat(2001),
      expectedUpdatedAt: null,
    });
    expect(parsed).toEqual({
      ok: false,
      fieldErrors: {
        content: { key: "lessonLog.tooLong", values: { max: 5000 } },
        homework: { key: "lessonLog.tooLong", values: { max: 2000 } },
      },
    });
    expect(
      parseInput(lessonLogSchema, {
        lessonId: LESSON,
        content: "x".repeat(5000),
        homework: "y".repeat(2000),
        expectedUpdatedAt: null,
      }).ok,
    ).toBe(true);
  });

  it("refuses malformed ids and timestamps", () => {
    const parsed = parseInput(lessonLogSchema, {
      lessonId: "nope",
      content: "a",
      homework: "",
      expectedUpdatedAt: "yesterday",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(Object.keys(parsed.fieldErrors).sort()).toEqual([
        "expectedUpdatedAt",
        "lessonId",
      ]);
    }
  });
});

describe("note schemas", () => {
  it("requires a body of at most 2,000 characters", () => {
    expect(
      parseInput(createNoteSchema, {
        lessonId: LESSON,
        about: "lesson",
        body: " ",
      }),
    ).toEqual({
      ok: false,
      fieldErrors: { body: { key: "validation.requiredField" } },
    });
    expect(
      parseInput(updateNoteSchema, { noteId: LESSON, body: "z".repeat(2001) }),
    ).toEqual({
      ok: false,
      fieldErrors: {
        body: { key: "teacherNotes.tooLong", values: { max: 2000 } },
      },
    });
  });

  it("accepts lesson, group or one student as the subject", () => {
    for (const about of ["lesson", "group", `student:${STUDENT}`]) {
      expect(
        parseInput(createNoteSchema, { lessonId: LESSON, about, body: "x" }).ok,
      ).toBe(true);
    }
    expect(
      parseInput(createNoteSchema, {
        lessonId: LESSON,
        about: "school",
        body: "x",
      }).ok,
    ).toBe(false);
    expect(parseAbout(`student:${STUDENT}`)).toEqual({
      kind: "student",
      id: STUDENT,
    });
    expect(parseAbout("group")).toEqual({ kind: "group" });
  });
});
