import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SchoolDb } from "@/server/timetable/service";

import {
  canReadTeacherNotes,
  findTeacherNotes,
  TeacherNoteAccessError,
} from "./teacher-notes";

function fakeDb() {
  const findMany = vi.fn(async () => []);
  return { db: { teacherNote: { findMany } } as unknown as SchoolDb, findMany };
}

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
          .filter(({ line }) => NOTE_ACCESS.test(line))
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
      expect(NOTE_ACCESS.test(line), line).toBe(true);
    }
  });
});
