"use server";

import { revalidatePath } from "next/cache";

import { type ActionResult, msg, ok } from "@/server/admin/result";
import { parseInput } from "@/server/admin/validation";
import { runTeacherAction } from "@/server/lessons/context";
import {
  createNoteSchema,
  lessonLogSchema,
  updateNoteSchema,
} from "@/server/lessons/schema";
import { saveLessonLog, type SaveLogResult } from "@/server/lessons/teacher";
import {
  createLessonNote,
  deleteLessonNote,
  loadEarlierNotes,
  type NoteView,
  updateLessonNote,
} from "@/server/notes/teacher-notes";

// Teacher lesson page actions (lessons.md §5.2–5.3). Each one re-checks the
// TEACHER role and only touches lessons the teacher teaches or substitutes;
// anything else is "not found".

function revalidateLessons(lessonId?: string) {
  if (lessonId) revalidatePath(`/teacher/lessons/${lessonId}`);
  revalidatePath("/teacher/lessons");
  revalidatePath("/teacher");
}

export async function saveLessonLogAction(input: {
  lessonId: string;
  content: string;
  homework: string;
  expectedUpdatedAt: string | null;
}): Promise<ActionResult<SaveLogResult>> {
  return runTeacherAction<SaveLogResult>(
    async ({ db, schoolId, teacherId }) => {
      const parsed = parseInput(lessonLogSchema, input);
      if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
      const result = await saveLessonLog(
        db,
        schoolId,
        teacherId,
        parsed.data,
        new Date(),
      );
      if (result.status === "conflict") return ok(result);
      revalidateLessons(parsed.data.lessonId);
      return ok(result, msg("lessonLog.saved"));
    },
  );
}

export async function createNoteAction(input: {
  lessonId: string;
  about: string;
  body: string;
}): Promise<ActionResult<NoteView>> {
  return runTeacherAction(async ({ db, schoolId, noteViewer }) => {
    const parsed = parseInput(createNoteSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const note = await createLessonNote(
      db,
      schoolId,
      noteViewer,
      parsed.data,
      new Date(),
    );
    revalidateLessons(parsed.data.lessonId);
    return ok(note, msg("teacherNotes.added"));
  });
}

export async function updateNoteAction(input: {
  noteId: string;
  body: string;
}): Promise<ActionResult<NoteView>> {
  return runTeacherAction(async ({ db, noteViewer }) => {
    const parsed = parseInput(updateNoteSchema, input);
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const note = await updateLessonNote(db, noteViewer, parsed.data);
    revalidateLessons();
    return ok(note, msg("common.toast.saved"));
  });
}

export async function deleteNoteAction(
  noteId: string,
): Promise<ActionResult<{ id: string }>> {
  return runTeacherAction(async ({ db, noteViewer }) => {
    await deleteLessonNote(db, noteViewer, String(noteId));
    revalidateLessons();
    return ok({ id: noteId }, msg("teacherNotes.deleted"));
  });
}

export async function loadEarlierNotesAction(
  lessonId: string,
  offset: number,
): Promise<ActionResult<NoteView[]>> {
  return runTeacherAction(async ({ db, noteViewer }) => {
    const notes = await loadEarlierNotes(
      db,
      noteViewer,
      String(lessonId),
      Number(offset) || 0,
      new Date(),
    );
    return ok(notes);
  });
}
