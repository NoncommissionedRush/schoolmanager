import { expect, test } from "@playwright/test";

import { sql } from "../helpers";
import {
  expectNoneOf,
  LOGINS,
  SCHOOL_A,
  SCHOOL_B,
  schoolIds,
  serverResponse,
  signedIn,
} from "./fixtures";

// Teacher internal notes never reach a student (project invariant,
// CARM-26): not on any page a student can open, not in the RSC payload
// inlined in those pages, not from an API route. Reads go through
// src/server/notes/teacher-notes.ts, whose unit test also fails if code
// elsewhere reads the table. The teacher lesson page (CARM-35) shows notes;
// students get the forbidden page there. Add new note screens here.

/** Every note body in the database, both schools. */
async function noteBodies() {
  const rows = await sql<{ body: string }>("SELECT body FROM teacher_notes");
  return rows.map((r) => r.body);
}

/** Weeks with each note's lesson (or the seed's current week). */
async function noteWeeks(schoolId: string) {
  const rows = await sql<{ week: string }>(
    `SELECT DISTINCT to_char(date_trunc('week', l.starts_at), 'YYYY-MM-DD') AS week
     FROM teacher_notes n JOIN lessons l ON l.id = n.lesson_id
     WHERE n.school_id = $1`,
    [schoolId],
  );
  return [...new Set(["2026-10-12", ...rows.map((r) => r.week)])];
}

/** Lessons with notes on them (their teacher lesson pages show the notes). */
async function notedLessons(schoolId: string) {
  const rows = await sql<{ id: string }>(
    `SELECT DISTINCT lesson_id AS id FROM teacher_notes
     WHERE school_id = $1 AND lesson_id IS NOT NULL`,
    [schoolId],
  );
  return rows.map((r) => r.id);
}

const studentPaths = (weeks: string[]) => [
  "/student",
  "/student/timetable",
  ...weeks.flatMap((week) => [
    `/student/timetable?week=${week}`,
    `/student/timetable?week=${week}&view=day`,
  ]),
  "/api/auth/session",
  "/api/health",
];

test.describe("teacher notes › never shown to students", () => {
  test("the seed has notes about the students we sign in as", async () => {
    // Without these the checks below would pass vacuously.
    for (const slug of [SCHOOL_A, SCHOOL_B]) {
      const ids = await schoolIds(slug);
      const [{ count }] = await sql<{ count: string }>(
        "SELECT count(*) FROM teacher_notes WHERE student_id = $1",
        [ids.student],
      );
      expect(Number(count), slug).toBeGreaterThan(0);
    }
  });

  for (const [school, slug] of [
    ["A", SCHOOL_A],
    ["B", SCHOOL_B],
  ] as const) {
    test(`a student of school ${school} gets no note through any page or API`, async ({
      browser,
    }) => {
      const bodies = await noteBodies();
      const ids = await schoolIds(slug);
      const page = await signedIn(browser, LOGINS[school].student, "student");
      for (const path of studentPaths(await noteWeeks(ids.school))) {
        const { body } = await serverResponse(page, path);
        expectNoneOf(body, bodies, path);
      }
      // Admin and teacher pages that would show notes about them.
      for (const path of [
        `/admin/students/${ids.student}`,
        `/admin/groups/${ids.group}`,
        `/admin/teachers/${ids.teacher}`,
        "/teacher",
        "/teacher/timetable",
        "/teacher/lessons",
        ...(await notedLessons(ids.school)).map(
          (id) => `/teacher/lessons/${id}`,
        ),
      ]) {
        const { body } = await serverResponse(page, path);
        expect(body, path).toContain("have access to this page");
        expectNoneOf(body, bodies, path);
      }
    });
  }
});
