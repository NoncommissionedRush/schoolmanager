import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { SchoolDb } from "@/server/timetable/service";

import {
  listStudentHomework,
  loadLatestHomework,
  loadStudentLesson,
  STUDENT_LESSON_KEYS,
  type StudentScope,
} from "./student";

const LESSON = "4b7f1f9e-3c1a-4a59-9d55-0b7c6f2f7a10";
const NOW = new Date("2026-10-20T18:00:00Z");
const TZ = "Europe/Bratislava";

/** A client where every query is recorded with its arguments. */
function recordingDb(rows: Record<string, unknown> = {}) {
  const calls: { model: string; operation: string; args: unknown }[] = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_, operation) => async (args: unknown) => {
          calls.push({ model: name, operation: String(operation), args });
          if (`${name}.${String(operation)}` in rows) {
            return rows[`${name}.${String(operation)}`];
          }
          return operation === "findMany" ? [] : null;
        },
      },
    );
  const db = new Proxy({}, { get: (_, name) => model(String(name)) });
  return { db: db as unknown as SchoolDb, calls };
}

const scope: StudentScope = {
  studentId: "s1",
  memberships: [
    { groupId: "g1", joinedAt: new Date("2026-09-01T00:00:00Z"), leftAt: null },
  ],
};

/** Every key anywhere in a nested Prisma `select`. */
function selectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) => [
    key,
    ...selectKeys(inner),
  ]);
}

describe("student lesson loaders", () => {
  it("never query internal notes or classmates", async () => {
    const { db, calls } = recordingDb();
    await loadStudentLesson(db, scope, LESSON, NOW, TZ);
    await listStudentHomework(db, scope, { shown: 20 }, NOW, TZ);
    await loadLatestHomework(db, scope, NOW, TZ);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.model).not.toBe("teacherNote");
      const keys = selectKeys((call.args as { select?: unknown })?.select);
      expect(keys).not.toContain("teacherNotes");
      expect(keys).not.toContain("memberships");
    }
  });

  it("limits the lesson page to lessons the student may read", async () => {
    const { db, calls } = recordingDb();
    expect(await loadStudentLesson(db, scope, LESSON, NOW, TZ)).toBeNull();
    const where = JSON.stringify(calls[0].args);
    // Membership window, published term, started.
    expect(where).toContain('"groupId":"g1"');
    expect(where).toContain("timetablePublishedAt");
    expect(where).toContain(`"lte":"${NOW.toISOString()}"`);
  });

  it("treats malformed ids and students without a profile as not found", async () => {
    const { db, calls } = recordingDb();
    expect(await loadStudentLesson(db, scope, "nonsense", NOW, TZ)).toBeNull();
    expect(
      await loadStudentLesson(
        db,
        { studentId: null, memberships: [] },
        LESSON,
        NOW,
        TZ,
      ),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("drops a row that slipped past the query (belt and braces)", async () => {
    const row = {
      id: LESSON,
      groupId: "other-group",
      startsAt: new Date("2026-10-13T15:00:00Z"),
      endsAt: new Date("2026-10-13T16:30:00Z"),
      status: "SCHEDULED",
      cancelReason: null,
      group: { name: "X", type: "GROUP", level: { code: "B1" } },
      teacher: { user: { name: "T" } },
      substituteTeacher: null,
      room: null,
      term: { timetablePublishedAt: new Date("2026-09-01T00:00:00Z") },
      log: null,
    };
    const { db } = recordingDb({ "lesson.findFirst": row });
    expect(await loadStudentLesson(db, scope, LESSON, NOW, TZ)).toBeNull();
    const ok = recordingDb({ "lesson.findFirst": { ...row, groupId: "g1" } });
    const view = await loadStudentLesson(ok.db, scope, LESSON, NOW, TZ);
    expect(Object.keys(view!).sort()).toEqual([...STUDENT_LESSON_KEYS].sort());
  });
});

describe("student-safe DTO", () => {
  it("has no field for internal notes or other students", () => {
    for (const key of STUDENT_LESSON_KEYS) {
      expect(key.toLowerCase()).not.toMatch(/note|student/);
    }
  });

  it("is built without the internal-notes module", () => {
    // Student loaders must never import src/server/notes (lessons.md §11).
    const root = path.resolve(__dirname, "../..");
    const files = [
      "server/lessons/student.ts",
      "server/lessons/student-rules.ts",
      "server/lessons/student-context.ts",
      "app/student/page.tsx",
      "app/student/homework/page.tsx",
      "app/student/lessons/[id]/page.tsx",
      "components/lessons/student-homework.tsx",
      "components/lessons/latest-homework-card.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(path.join(root, file), "utf8");
      expect(source, file).not.toMatch(
        /from\s+["'][^"']*(server\/notes|teacher-notes)/,
      );
      expect(source, file).not.toMatch(/\.teacherNotes?\b/);
    }
  });
});
