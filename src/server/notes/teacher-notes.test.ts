import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SchoolDb } from "@/server/timetable/service";

import {
  canReadTeacherNotes,
  createLessonNote,
  deleteLessonNote,
  findTeacherNotes,
  loadEarlierNotes,
  loadLessonNotes,
  loadStudentNotes,
  TeacherNoteAccessError,
  updateLessonNote,
} from "./teacher-notes";

function fakeDb() {
  const findMany = vi.fn(async () => []);
  return { db: { teacherNote: { findMany } } as unknown as SchoolDb, findMany };
}

/** A client where every query is recorded and returns nothing. */
function recordingDb() {
  const calls: string[] = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_, operation) => async () => {
          calls.push(`${name}.${String(operation)}`);
          return operation === "findMany" ? [] : null;
        },
      },
    );
  const db = new Proxy({}, { get: (_, name) => model(String(name)) });
  return { db: db as unknown as SchoolDb, calls };
}

const LESSON = "4b7f1f9e-3c1a-4a59-9d55-0b7c6f2f7a10";
const NOW = new Date("2026-10-20T18:00:00Z");

describe("canReadTeacherNotes", () => {
  it.each([
    ["ADMIN", true],
    ["TEACHER", true],
    ["STUDENT", false],
  ] as const)("%s → %s", (role, allowed) => {
    expect(canReadTeacherNotes(role)).toBe(allowed);
  });
});

describe("findTeacherNotes", () => {
  it("refuses a student before querying", async () => {
    const { db, findMany } = fakeDb();
    await expect(
      findTeacherNotes(db, { role: "STUDENT" }, { studentId: "s1" }),
    ).rejects.toBeInstanceOf(TeacherNoteAccessError);
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each(["ADMIN", "TEACHER"] as const)("lets a %s read", async (role) => {
    const { db, findMany } = fakeDb();
    await findTeacherNotes(
      db,
      { role },
      { studentId: "s1", groupId: undefined },
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studentId: "s1" } }),
    );
  });

  it("needs something to filter by", async () => {
    const { db, findMany } = fakeDb();
    await expect(findTeacherNotes(db, { role: "ADMIN" }, {})).rejects.toThrow();
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("lesson page notes: student refusal", () => {
  const student = { role: "STUDENT" as const, teacherId: null };
  const entryPoints: [string, (db: SchoolDb) => Promise<unknown>][] = [
    ["loadLessonNotes", (db) => loadLessonNotes(db, student, LESSON, NOW)],
    ["loadEarlierNotes", (db) => loadEarlierNotes(db, student, LESSON, 0, NOW)],
    [
      "createLessonNote",
      (db) =>
        createLessonNote(
          db,
          "school",
          student,
          { lessonId: LESSON, about: "lesson", body: "x" },
          NOW,
        ),
    ],
    [
      "updateLessonNote",
      (db) => updateLessonNote(db, student, { noteId: LESSON, body: "x" }),
    ],
    ["deleteLessonNote", (db) => deleteLessonNote(db, student, LESSON)],
  ];

  it.each(entryPoints)(
    "%s refuses a student before any query",
    async (_, run) => {
      const { db, calls } = recordingDb();
      await expect(run(db)).rejects.toBeInstanceOf(TeacherNoteAccessError);
      expect(calls).toEqual([]);
    },
  );
});

describe("lesson page notes: teachers and admins", () => {
  it("is not found for a teacher without a lesson of theirs", async () => {
    const { db, calls } = recordingDb();
    await expect(
      loadLessonNotes(db, { role: "TEACHER", teacherId: null }, LESSON, NOW),
    ).rejects.toMatchObject({ error: { key: "common.error.notFound" } });
    expect(calls).toEqual([]);
  });

  it("is not found when the teacher doesn't teach the lesson", async () => {
    const { db, calls } = recordingDb();
    await expect(
      loadLessonNotes(db, { role: "TEACHER", teacherId: "t1" }, LESSON, NOW),
    ).rejects.toMatchObject({ error: { key: "common.error.notFound" } });
    expect(calls).toEqual(["lesson.findFirst"]);
  });

  it("treats malformed lesson ids as not found", async () => {
    const { db, calls } = recordingDb();
    await expect(
      loadLessonNotes(db, { role: "ADMIN" }, "not-a-uuid", NOW),
    ).rejects.toMatchObject({ error: { key: "common.error.notFound" } });
    expect(calls).toEqual([]);
  });

  it("never lets an admin write notes", async () => {
    const { db, calls } = recordingDb();
    await expect(
      createLessonNote(
        db,
        "school",
        { role: "ADMIN" },
        { lessonId: LESSON, about: "lesson", body: "x" },
        NOW,
      ),
    ).rejects.toMatchObject({ error: { key: "common.error.notFound" } });
    await expect(
      deleteLessonNote(db, { role: "ADMIN" }, LESSON),
    ).rejects.toMatchObject({ error: { key: "common.error.notFound" } });
    expect(calls).toEqual([]);
  });
});

describe("student detail notes", () => {
  const STUDENT = "0b7c6f2f-3c1a-4a59-9d55-4b7f1f9e7a10";

  it("refuses students before querying", async () => {
    const { db, calls } = recordingDb();
    await expect(
      loadStudentNotes(db, { role: "STUDENT" }, STUDENT),
    ).rejects.toBeInstanceOf(TeacherNoteAccessError);
    expect(calls).toEqual([]);
  });

  it("is admin-only: teachers and malformed ids get not found", async () => {
    const { db, calls } = recordingDb();
    await expect(
      loadStudentNotes(db, { role: "TEACHER", teacherId: "t1" }, STUDENT),
    ).rejects.toMatchObject({ error: { key: "common.error.notFound" } });
    await expect(
      loadStudentNotes(db, { role: "ADMIN" }, "nonsense"),
    ).rejects.toMatchObject({ error: { key: "common.error.notFound" } });
    expect(calls).toEqual([]);
  });

  it("lets an admin read the student's notes", async () => {
    const { db, calls } = recordingDb();
    expect(await loadStudentNotes(db, { role: "ADMIN" }, STUDENT)).toEqual([]);
    expect(calls).toEqual(["teacherNote.findMany"]);
  });
});

// Static guard: TeacherNote rows may only be read through findTeacherNotes.
// A direct `db.teacherNote…` call, a relation read (`teacherNotes`,
// `notesAbout`, a teacher's `notes`) or raw SQL on `teacher_notes` anywhere
// else in src/ fails here. Add an exception only for code that can never
// return note content, and say why.
const ALLOWED: Record<string, RegExp> = {
  // Counts dependents before deleting a lesson; returns a number, admin only.
  "src/server/timetable/service.ts": /^\s*teacherNotes: true,$/,
};

const NOTE_ACCESS =
  /\bteacherNotes?\b|\bnotesAbout\b|\bteacher_notes\b|\bnotes\s*:\s*(true|\{)/;

// The `teacherNotes` i18n namespace ("teacherNotes.title") names copy, not
// data: string literals of it are ignored.
const I18N_KEY = /(["'`])teacherNotes(\.[\w.]+)?\1/g;
const readsNotes = (line: string) =>
  NOTE_ACCESS.test(line.replace(I18N_KEY, '""'));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "generated" ? [] : sourceFiles(file);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [file]
      : [];
  });
}

describe("TeacherNote read paths", () => {
  it("only src/server/notes reads teacher notes", () => {
    const offenders = sourceFiles("src")
      .filter((file) => !file.startsWith(path.join("src", "server", "notes")))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, i) => ({ file, line, at: `${file}:${i + 1}` }))
          .filter(({ line }) => readsNotes(line))
          .filter(({ file, line }) => !ALLOWED[file]?.test(line)),
      )
      .map(({ at, line }) => `${at}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  it("catches a direct read", () => {
    for (const line of [
      "await db.teacherNote.findMany({ where });",
      "include: { teacherNotes: true },",
      "select: { notesAbout: { select: { body: true } } },",
      "notes: { select: { body: true } },",
      "await db.$queryRaw`SELECT body FROM teacher_notes`;",
    ]) {
      expect(readsNotes(line), line).toBe(true);
    }
  });

  it("ignores the teacherNotes i18n namespace", () => {
    for (const line of [
      'const t = useTranslations("teacherNotes");',
      'return ok(note, msg("teacherNotes.added"));',
    ]) {
      expect(readsNotes(line), line).toBe(false);
    }
    expect(
      readsNotes('t("teacherNotes.title"); db.teacherNote.findMany()'),
    ).toBe(true);
  });
});
