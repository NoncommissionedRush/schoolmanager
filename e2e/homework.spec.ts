import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { DEMO_LOGINS, insertOwnTerm, signIn, sql } from "./helpers";

// Happy path of CARM-36 (lessons.md §6–7): a teacher writes the log and the
// homework, the student sees it on the home card, the Homework tab and the
// lesson page — never the internal note — and an admin reads it all,
// read-only. Runs on its own group, student, term and lessons so it doesn't
// depend on (or change) the seeded data.
test.describe("homework › teacher writes, student reads, admin views", () => {
  test.describe.configure({ mode: "serial" });
  const suffix = randomUUID().slice(0, 8);
  const group = `E2E Homework ${suffix}`;
  const studentEmail = `e2e-homework-${suffix}@demo-school.test`;
  const ids = {
    term: randomUUID(),
    group: randomUUID(),
    user: randomUUID(),
    student: randomUUID(),
    lesson: randomUUID(), // ended an hour ago; the teacher logs it
    before: randomUUID(), // three days ago, before the student joined
  };
  const COVERED = "Unit 4: present perfect vs past simple.";
  const HOMEWORK = "One page essay about your favourite movie.";
  const NOTE = `Needs extra time in written tasks ${suffix}.`;

  test.beforeAll(async () => {
    const [row] = await sql<{
      school: string;
      level: string;
      teacher: string;
      hash: string;
    }>(
      `SELECT s.id AS school, g.level_id AS level, tp.id AS teacher, su.password_hash AS hash
       FROM schools s
       JOIN groups g ON g.school_id = s.id AND g.name = 'A2 Evening'
       JOIN teacher_profiles tp ON tp.school_id = s.id
       JOIN users u ON u.id = tp.user_id AND u.email = $1
       JOIN users su ON su.email = $2
       WHERE s.slug = 'demo-language-school'`,
      [DEMO_LOGINS.teacher, DEMO_LOGINS.student],
    );
    // A January term, away from the weeks other specs look at.
    await insertOwnTerm({
      id: ids.term,
      schoolId: row.school,
      name: `E2E Homework ${suffix}`,
      startDate: "2026-01-12",
      days: 7,
      published: true,
    });
    await sql(
      `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at)
       VALUES ($1, $2, $3, 'GROUP', $4, 8, now())`,
      [ids.group, row.school, row.level, group],
    );
    await sql(
      `INSERT INTO users (id, email, name, password_hash, updated_at)
       VALUES ($1, $2, 'Hana Homework', $3, now())`,
      [ids.user, studentEmail, row.hash],
    );
    await sql(
      `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'STUDENT', now())`,
      [row.school, ids.user],
    );
    await sql(
      `INSERT INTO student_profiles (id, school_id, user_id, updated_at)
       VALUES ($1, $2, $3, now())`,
      [ids.student, row.school, ids.user],
    );
    await sql(
      `INSERT INTO group_memberships (id, school_id, group_id, student_id, joined_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now() - interval '1 day', now())`,
      [row.school, ids.group, ids.student],
    );
    await sql(
      `INSERT INTO lessons (id, school_id, term_id, group_id, teacher_id, starts_at, ends_at, updated_at)
       VALUES ($1, $3, $4, $5, $6, now() - interval '150 minutes', now() - interval '60 minutes', now()),
              ($2, $3, $4, $5, $6, now() - interval '3 days', now() - interval '3 days' + interval '90 minutes', now())`,
      [ids.lesson, ids.before, row.school, ids.term, ids.group, row.teacher],
    );
    await sql(
      `INSERT INTO lesson_logs (id, school_id, lesson_id, author_id, updated_by_id, content, homework, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $3, 'Before you joined', 'Old homework', now())`,
      [row.school, ids.before, row.teacher],
    );
  });

  test.afterAll(async () => {
    const lessons = [ids.lesson, ids.before];
    await sql("DELETE FROM teacher_notes WHERE lesson_id = ANY($1)", [lessons]);
    await sql("DELETE FROM lesson_logs WHERE lesson_id = ANY($1)", [lessons]);
    await sql("DELETE FROM lessons WHERE id = ANY($1)", [lessons]);
    await sql("DELETE FROM group_memberships WHERE group_id = $1", [ids.group]);
    await sql("DELETE FROM student_profiles WHERE id = $1", [ids.student]);
    await sql("DELETE FROM memberships WHERE user_id = $1", [ids.user]);
    await sql("DELETE FROM users WHERE id = $1", [ids.user]);
    await sql("DELETE FROM groups WHERE id = $1", [ids.group]);
    await sql("DELETE FROM terms WHERE id = $1", [ids.term]);
  });

  test("the student sees the homework, never the internal note", async ({
    browser,
  }) => {
    // Teacher: write the log and the homework, add an internal note.
    const teacherContext = await browser.newContext();
    const teacher = await teacherContext.newPage();
    await signIn(teacher, DEMO_LOGINS.teacher);
    await teacher.waitForURL("/teacher");
    await teacher.goto(`/teacher/lessons/${ids.lesson}`);
    await teacher.getByLabel("What we covered").fill(COVERED);
    await teacher.getByLabel("Homework (optional)").fill(HOMEWORK);
    await teacher.getByRole("button", { name: "Save", exact: true }).click();
    await expect(teacher.getByText("Lesson log saved.")).toBeVisible();
    const internal = teacher.getByRole("region", { name: "Internal notes" });
    await internal
      .getByLabel("Internal note (students can't see this)")
      .fill(NOTE);
    await internal.getByRole("button", { name: "Add note" }).click();
    await expect(teacher.getByText("Note added.")).toBeVisible();
    await teacherContext.close();

    // Student: home card → lesson page → Homework tab.
    const studentContext = await browser.newContext();
    const page = await studentContext.newPage();
    await signIn(page, studentEmail);
    await page.waitForURL("/student");
    const card = page
      .locator("[data-slot=card]")
      .filter({ has: page.getByRole("heading", { name: "Latest homework" }) });
    await expect(card.getByText(HOMEWORK)).toBeVisible();
    await card.getByRole("link", { name: new RegExp(group) }).click();
    await page.waitForURL(`/student/lessons/${ids.lesson}`);
    await expect(
      page.getByRole("heading", { level: 1, name: group }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Homework" }).getByText(HOMEWORK),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "What we covered" }).getByText(COVERED),
    ).toBeVisible();
    await expect(page.getByText(NOTE)).toHaveCount(0);
    await expect(page.getByText(/Internal/)).toHaveCount(0);

    await page.getByRole("link", { name: "Homework" }).first().click();
    await page.waitForURL("/student/homework");
    await expect(
      page.getByRole("heading", { level: 1, name: "Homework" }),
    ).toBeVisible();
    const lesson = page
      .locator(`a[href="/student/lessons/${ids.lesson}"]`)
      .filter({ visible: true });
    await expect(lesson).toContainText(HOMEWORK);
    await expect(lesson).toContainText(`We covered: ${COVERED}`);
    // The lesson before they joined isn't theirs: not listed, and "not
    // found" (a streamed page keeps HTTP 200, so check the content).
    await expect(page.getByText("Old homework")).toHaveCount(0);
    await page.goto(`/student/lessons/${ids.before}`);
    await expect(page.getByText("Page not found")).toBeVisible();
    await expect(page.getByText("Old homework")).toHaveCount(0);
    await studentContext.close();
  });

  test("an admin reads the lesson and its internal notes, read-only", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto(`/admin/lessons/${ids.before}`);
    await expect(
      page.getByRole("heading", { level: 1, name: group }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Admins can view this lesson. Teachers write the lesson log and homework.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Old homework")).toBeVisible();
    await expect(page.getByLabel("What we covered")).toHaveCount(0);
    const internal = page.getByRole("region", { name: "Internal notes" });
    await expect(
      internal.getByText("Internal — only teachers and admins see this"),
    ).toBeVisible();
    await expect(
      internal.getByRole("button", { name: "Add note" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Open in timetable" }),
    ).toBeVisible();
  });
});
