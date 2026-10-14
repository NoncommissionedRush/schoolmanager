import { z } from "zod";

import { encodeMessage, id } from "@/server/admin/validation";

import { COVERED_MAX, HOMEWORK_MAX, NOTE_MAX } from "./rules";

// Shared by the lesson page (client-side checks) and the server actions
// (source of truth). Limits mirror lessons.md §11 and the CHECK constraints
// in the migration.

/** Plain text, trimmed at the ends (line breaks inside are kept); empty → null. */
function optionalPlainText(max: number, key: string) {
  return z.preprocess(
    (value) => {
      const text = typeof value === "string" ? value.trim() : "";
      return text === "" ? null : text;
    },
    z
      .string()
      .max(max, { error: encodeMessage(key, { max }) })
      .nullable(),
  );
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const lessonLogSchema = z.object({
  lessonId: id("lessons.title"),
  content: optionalPlainText(COVERED_MAX, "lessonLog.tooLong"),
  homework: optionalPlainText(HOMEWORK_MAX, "lessonLog.tooLong"),
  /** `updatedAt` of the record the form was loaded with; null = none. */
  expectedUpdatedAt: z.preprocess(
    (value) => (value === "" || value === undefined ? null : value),
    z
      .string()
      .regex(ISO_INSTANT, { error: encodeMessage("common.error.unexpected") })
      .nullable(),
  ),
});

export type LessonLogInput = z.output<typeof lessonLogSchema>;

const noteBody = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : ""),
  z
    .string()
    .min(1, { error: encodeMessage("validation.requiredField") })
    .max(NOTE_MAX, {
      error: encodeMessage("teacherNotes.tooLong", { max: NOTE_MAX }),
    }),
);

/** "About" in the add form: `lesson`, `group` or `student:<id>`. */
const about = z.union([
  z.literal("lesson"),
  z.literal("group"),
  z.string().regex(/^student:[0-9a-f-]{36}$/i),
]);

export const createNoteSchema = z.object({
  lessonId: id("lessons.title"),
  about,
  body: noteBody,
});

export const updateNoteSchema = z.object({
  noteId: id("teacherNotes.title"),
  body: noteBody,
});

export type CreateNoteInput = z.output<typeof createNoteSchema>;
export type UpdateNoteInput = z.output<typeof updateNoteSchema>;

/** The note's subject from the add form's `about` value. */
export function parseAbout(
  value: CreateNoteInput["about"],
): { kind: "lesson" } | { kind: "group" } | { kind: "student"; id: string } {
  if (value === "lesson" || value === "group") return { kind: value };
  return { kind: "student", id: value.slice("student:".length) };
}
