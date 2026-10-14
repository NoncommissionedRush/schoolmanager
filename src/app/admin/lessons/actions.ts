"use server";

import { type ActionResult, ok } from "@/server/admin/result";
import { runAdminAction } from "@/server/admin/context";
import { loadEarlierNotes, type NoteView } from "@/server/notes/teacher-notes";

// The admin lesson page is read-only (lessons.md §7, decision §12.1): the
// only action pages through earlier internal notes.

export async function loadEarlierNotesAction(
  lessonId: string,
  offset: number,
): Promise<ActionResult<NoteView[]>> {
  return runAdminAction(async ({ db, viewer }) => {
    const notes = await loadEarlierNotes(
      db,
      { role: viewer.role },
      String(lessonId),
      Number(offset) || 0,
      new Date(),
    );
    return ok(notes);
  });
}
