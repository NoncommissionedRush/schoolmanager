import { expect, type Page, test } from "@playwright/test";

import { callAction } from "../server-actions";
import { sql } from "../helpers";
import {
  expectNoneOf,
  LOGINS,
  SCHOOL_A,
  SCHOOL_B,
  SECOND_NAMES,
  schoolIds,
  serverResponse,
  signedIn,
} from "./fixtures";

// The teacher lesson page and its actions (CARM-35, lessons.md §2): a
// teacher only opens lessons they teach or substitute — anything else is
// 404, also across schools — and the actions refuse those lessons without
// changing anything. Students can't reach any of it. The full Phase 2
// permission suite is CARM-37.

const ACTIONS = "src/app/teacher/lessons/actions.ts";

/**
 * A past lesson of school A in a group the demo teacher never teaches or
 * substitutes, so its group name must not show up on their pages.
 */
async function colleaguesLesson(schoolId: string, teacherId: string) {
  const [row] = await sql<{ id: string; group: string }>(
    `SELECT l.id, g.name AS "group" FROM lessons l
     JOIN terms t ON t.id = l.term_id
     JOIN groups g ON g.id = l.group_id
     WHERE l.school_id = $1 AND t.timetable_published_at IS NOT NULL
       AND l.starts_at < now() AND l.status = 'SCHEDULED'
       AND NOT EXISTS (
         SELECT 1 FROM lessons o WHERE o.group_id = l.group_id
           AND (o.teacher_id = $2 OR o.substitute_teacher_id = $2))
     ORDER BY l.starts_at DESC LIMIT 1`,
    [schoolId, teacherId],
  );
  return row;
}

/**
 * The lesson page renders "not found" and nothing of a lesson. Not-found
 * inside a streamed page keeps HTTP 200 (as for the admin detail pages), so
 * check the content.
 */
async function expectNotFound(page: Page, path: string, leaks: string[] = []) {
  const { body } = await serverResponse(page, path);
  expect(body, path).toContain("Page not found");
  expectNoneOf(body, leaks, path);
}

async function groupName(groupId: string) {
  const [row] = await sql<{ name: string }>(
    "SELECT name FROM groups WHERE id = $1",
    [groupId],
  );
  return row.name;
}

async function logAndNotes(lessonId: string) {
  return sql(
    `SELECT 'log' AS kind, id::text, coalesce(content, '') || coalesce(homework, '') AS body
       FROM lesson_logs WHERE lesson_id = $1
     UNION ALL
     SELECT 'note', id::text, body FROM teacher_notes WHERE lesson_id = $1
     ORDER BY 1, 2`,
    [lessonId],
  );
}

test.describe("teacher lessons › access", () => {
  test("a teacher gets 404 for a colleague's lesson, and the actions refuse it", async ({
    browser,
  }) => {
    const a = await schoolIds(SCHOOL_A);
    const { id: lessonId, group } = await colleaguesLesson(a.school, a.teacher);
    const page = await signedIn(browser, LOGINS.A.teacher, "teacher");

    // Their own lesson opens (control), the colleague's doesn't.
    const own = await serverResponse(page, `/teacher/lessons/${a.lesson}`);
    expect(own.status).toBe(200);
    await expectNotFound(page, `/teacher/lessons/${lessonId}`, [group]);
    await expectNotFound(page, "/teacher/lessons/not-a-uuid");

    const before = await logAndNotes(lessonId);
    const notFound = { ok: false, formError: { key: "common.error.notFound" } };
    const calls: [string, unknown[]][] = [
      [
        "saveLessonLogAction",
        [{ lessonId, content: "Leak", homework: "", expectedUpdatedAt: null }],
      ],
      ["createNoteAction", [{ lessonId, about: "lesson", body: "Leak" }]],
      ["loadEarlierNotesAction", [lessonId, 0]],
    ];
    for (const [name, args] of calls) {
      const { status, result } = await callAction(page, [ACTIONS, name], args);
      expect(status, name).toBe(200);
      expect(result, name).toMatchObject(notFound);
    }
    expect(await logAndNotes(lessonId)).toEqual(before);
  });

  test("a teacher of school B gets 404 for school A's lessons", async ({
    browser,
  }) => {
    const a = await schoolIds(SCHOOL_A);
    const b = await schoolIds(SCHOOL_B);
    const pageA = await signedIn(browser, LOGINS.A.teacher, "teacher");
    const list = await serverResponse(pageA, "/teacher/lessons?filter=past");
    expect(list.status).toBe(200);
    expectNoneOf(list.body, Object.values(SECOND_NAMES), "/teacher/lessons");
    await expectNotFound(
      pageA,
      `/teacher/lessons/${b.lesson}`,
      Object.values(SECOND_NAMES),
    );

    const pageB = await signedIn(browser, LOGINS.B.teacher, "teacher");
    const own = await serverResponse(pageB, `/teacher/lessons/${b.lesson}`);
    expect(own.status).toBe(200);
    expect(own.body).toContain(SECOND_NAMES.group);
    await expectNotFound(pageB, `/teacher/lessons/${a.lesson}`, [
      await groupName(a.group),
    ]);
  });

  test("students and admins can't open teacher lesson pages or run their actions", async ({
    browser,
  }) => {
    const a = await schoolIds(SCHOOL_A);
    // Under `pnpm dev`, the actions exist once a page using them compiled.
    const teacher = await signedIn(browser, LOGINS.A.teacher, "teacher");
    await serverResponse(teacher, `/teacher/lessons/${a.lesson}`);
    const before = await logAndNotes(a.lesson);
    for (const role of ["student", "admin"] as const) {
      const page = await signedIn(browser, LOGINS.A[role], role);
      for (const path of ["/teacher/lessons", `/teacher/lessons/${a.lesson}`]) {
        const { status, body } = await serverResponse(page, path);
        expect(status, `${role} ${path}`).toBe(403);
        expect(body).toContain("have access to this page");
      }
      const { result } = await callAction(
        page,
        [ACTIONS, "createNoteAction"],
        [{ lessonId: a.lesson, about: "lesson", body: "Leak" }],
      );
      expect(result, role).toBeNull();
    }
    expect(await logAndNotes(a.lesson)).toEqual(before);
  });
});
