import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { DEMO_LOGINS, signIn, sql } from "./helpers";

// Happy path of the teacher lesson page (CARM-35, lessons.md §5): find a
// lesson without a log, write what was covered and the homework, guard
// unsaved changes, add / edit / delete an internal note, and remove the log
// again. Runs on its own ad-hoc lesson that ended an hour ago, so it doesn't
// depend on (or change) the seeded lessons.
const GROUP = "A2 Evening";

test.describe("teacher lesson page › log, homework and internal notes", () => {
  const lessonId = randomUUID();
  const termId = randomUUID();
  // Its own published term (dated in January, away from the weeks other
  // specs look at), so specs that digest the seeded term's lessons aren't
  // disturbed. The lesson itself ended an hour ago.
  const termName = `E2E Lesson log ${Date.now()}`;

  test.beforeAll(async () => {
    const [row] = await sql<{ school: string; group: string; teacher: string }>(
      `SELECT s.id AS school, g.id AS "group", tp.id AS teacher
       FROM schools s
       JOIN groups g ON g.school_id = s.id AND g.name = $1
       JOIN teacher_profiles tp ON tp.school_id = s.id
       JOIN users u ON u.id = tp.user_id AND u.email = $2
       WHERE s.slug = 'demo-language-school'`,
      [GROUP, DEMO_LOGINS.teacher],
    );
    await sql(
      `INSERT INTO terms (id, school_id, name, start_date, end_date, timetable_published_at, updated_at)
       VALUES ($1, $2, $3, '2026-01-05', '2026-01-11', now(), now())`,
      [termId, row.school, termName],
    );
    await sql(
      `INSERT INTO lessons (id, school_id, term_id, group_id, teacher_id, starts_at, ends_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now() - interval '150 minutes', now() - interval '60 minutes', now())`,
      [lessonId, row.school, termId, row.group, row.teacher],
    );
  });

  test.afterAll(async () => {
    await sql("DELETE FROM teacher_notes WHERE lesson_id = $1", [lessonId]);
    await sql("DELETE FROM lesson_logs WHERE lesson_id = $1", [lessonId]);
    await sql("DELETE FROM lessons WHERE id = $1", [lessonId]);
    await sql("DELETE FROM terms WHERE id = $1", [termId]);
  });

  test("write the log, then add and remove an internal note", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.teacher);
    await page.waitForURL("/teacher");
    await expect(page.getByRole("heading", { name: "To do" })).toBeVisible();

    // Lesson log list › No log yet › our lesson.
    await page.getByRole("link", { name: "Lesson log" }).first().click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Lesson log" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /^No log yet \(\d+\)$/ }),
    ).toHaveAttribute("aria-current", "page");
    await page.getByLabel("Term").selectOption({ label: termName });
    await page.waitForURL(/[?&]term=/);
    await page
      .locator(`a[href="/teacher/lessons/${lessonId}?from=list"]`)
      .first()
      .click();
    await page.waitForURL(`/teacher/lessons/${lessonId}?from=list`);

    await expect(
      page.getByRole("heading", { level: 1, name: GROUP }),
    ).toBeVisible();
    await expect(
      page.getByText("No log yet", { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Students in this group can see this."),
    ).toBeVisible();

    const covered = page.getByLabel("What we covered");
    const homework = page.getByLabel("Homework (optional)");
    await covered.fill("Unit 4: present perfect vs past simple.");
    await homework.fill("One page essay about your favourite movie.");

    // Leaving with unsaved changes asks first.
    await page.getByRole("link", { name: "Lesson log" }).first().click();
    const discard = page.getByRole("alertdialog", {
      name: "Discard unsaved changes?",
    });
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Keep editing" }).click();
    await expect(page).toHaveURL(new RegExp(`/teacher/lessons/${lessonId}`));
    await expect(covered).toHaveValue(
      "Unit 4: present perfect vs past simple.",
    );

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Lesson log saved.")).toBeVisible();
    await expect(
      page.getByText(/^Last saved by Jana Nováková, /),
    ).toBeVisible();
    await expect(
      page.getByText("No log yet", { exact: true }).filter({ visible: true }),
    ).toHaveCount(0);
    const [saved] = await sql<{ content: string; homework: string }>(
      "SELECT content, homework FROM lesson_logs WHERE lesson_id = $1",
      [lessonId],
    );
    expect(saved).toEqual({
      content: "Unit 4: present perfect vs past simple.",
      homework: "One page essay about your favourite movie.",
    });

    // Internal note about the group: always in the internal style.
    const internal = page.getByRole("region", { name: "Internal notes" });
    await expect(
      internal.getByText("Internal — only teachers and admins see this"),
    ).toBeVisible();
    await internal
      .getByLabel("About")
      .selectOption({ label: `Group: ${GROUP}` });
    await internal
      .getByLabel("Internal note (students can't see this)")
      .fill("Needs extra time in written tasks.");
    await internal.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByText("Note added.")).toBeVisible();
    const note = internal
      .getByRole("listitem")
      .filter({ hasText: "Needs extra time in written tasks." });
    await expect(note.getByText(`Group: ${GROUP}`)).toBeVisible();

    await note.getByRole("button", { name: "Note actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    // While editing, the body is in a textarea, so find the form by its button.
    const editor = internal
      .getByRole("listitem")
      .filter({ has: page.getByRole("button", { name: "Save note" }) });
    await editor
      .getByLabel("Internal note (students can't see this)")
      .fill("Needs extra time in written tasks!");
    await editor.getByRole("button", { name: "Save note" }).click();
    const edited = internal
      .getByRole("listitem")
      .filter({ hasText: "Needs extra time in written tasks!" });
    await expect(edited).toBeVisible();

    await edited.getByRole("button", { name: "Note actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page
      .getByRole("alertdialog", { name: "Delete this note?" })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(
      internal.getByText("Needs extra time in written tasks!"),
    ).toHaveCount(0);
    await expect(internal.getByText(/^No internal notes yet\./)).toBeVisible();

    // Both fields empty removes the log after a confirmation.
    await covered.fill("");
    await homework.fill("");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page
      .getByRole("alertdialog", { name: "Remove the lesson log and homework?" })
      .getByRole("button", { name: "Remove" })
      .click();
    await expect(page.getByText(/^Last saved by/)).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await sql("SELECT 1 FROM lesson_logs WHERE lesson_id = $1", [
              lessonId,
            ])
          ).length,
      )
      .toBe(0);
  });

  test("opened directly, the back link leads to the lesson's week", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.teacher);
    await page.waitForURL("/teacher");
    const [{ week }] = await sql<{ week: string }>(
      `SELECT to_char(date_trunc('week', starts_at AT TIME ZONE 'Europe/Bratislava'), 'YYYY-MM-DD') AS week
       FROM lessons WHERE id = $1`,
      [lessonId],
    );
    await page.goto(`/teacher/lessons/${lessonId}`);
    await expect(
      page.locator("#content").getByRole("link", { name: "My timetable" }),
    ).toHaveAttribute("href", `/teacher/timetable?week=${week}`);
  });
});
