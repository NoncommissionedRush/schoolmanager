import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  insertOwnSchool,
  removeSchool,
  signIn,
  sql,
  usersOf,
} from "../helpers";

/**
 * Assign teachers (docs/design/timetable-generator.md): set a group's
 * lesson times and a teacher's levels, generate a draft for a term of its
 * own, pick a teacher by hand, then publish.
 *
 * Runs in a school of its own: the generator assigns every group of the
 * school and offers every teacher, and other specs add (and hard-delete)
 * teachers and groups in the seeded school while this one runs.
 */

const TERM_NAME = "E2E Assign teachers term";
const TERM_START = "2041-01-07";
const TERM_END = "2041-02-24";

test.describe("admin › assign teachers", () => {
  test.describe.configure({ mode: "serial" });

  let own: Awaited<ReturnType<typeof insertOwnSchool>>;
  let termId: string;
  const stamp = Date.now();
  const groupName = `E2E Assign Group ${stamp}`;
  const teacherName = `E2E Assign Teacher ${stamp}`;

  test.beforeAll(async () => {
    own = await insertOwnSchool(randomUUID().slice(0, 8), "Ada Assign");
    const school = own.school;
    await sql(
      `INSERT INTO levels (id, school_id, code, name, rank, updated_at)
       VALUES (gen_random_uuid(), $1, 'A1', 'Beginner', 1, now()),
              (gen_random_uuid(), $1, 'A2', 'Elementary', 2, now()),
              (gen_random_uuid(), $1, 'B1', 'Intermediate', 3, now()),
              (gen_random_uuid(), $1, 'B2', 'Upper intermediate', 4, now())`,
      [school],
    );
    await sql(
      `INSERT INTO rooms (id, school_id, name, kind, updated_at)
       VALUES (gen_random_uuid(), $1, 'Online classroom', 'ONLINE', now())`,
      [school],
    );
    const [term] = await sql<{ id: string }>(
      `INSERT INTO terms (id, school_id, name, start_date, end_date, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now()) RETURNING id`,
      [school, TERM_NAME, TERM_START, TERM_END],
    );
    termId = term.id;
    await sql(
      `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at)
       SELECT gen_random_uuid(), $1, id, 'GROUP', $2, 8, now()
       FROM levels WHERE school_id = $1 AND code = 'A1'`,
      [school, groupName],
    );
  });

  test.afterAll(async () => {
    const users = await usersOf(own.school);
    await removeSchool(own.school);
    await sql("DELETE FROM users WHERE id = ANY($1::uuid[])", [users]);
  });

  test("set the levels a teacher teaches and their weekly maximum", async ({
    page,
  }) => {
    await signIn(page, own.adminEmail);
    await page.waitForURL("/admin");
    await page.goto("/admin/teachers");
    // The school has no teachers yet: the empty state's button.
    await page.getByRole("button", { name: "Add teacher" }).click();
    const dialog = page.getByRole("dialog", { name: "New teacher" });
    await dialog.getByLabel("Full name").fill(teacherName);
    await dialog.getByLabel("Email").fill(`e2e.assign.${stamp}@example.test`);
    await dialog.getByRole("button", { name: "Generate" }).click();
    await dialog.getByRole("button", { name: "Create teacher" }).click();
    await page
      .getByRole("dialog", { name: "Share these sign-in details" })
      .getByRole("button", { name: "Done" })
      .click();

    await page
      .getByRole("searchbox", { name: "Search by name or email" })
      .fill(teacherName);
    await page.waitForURL(/[?&]q=/);
    await page.getByRole("link", { name: teacherName }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      teacherName,
    );

    const levels = page.getByTestId("teacher-levels");
    await levels.getByRole("combobox", { name: "Up to…" }).selectOption({
      label: "Up to B1",
    });
    await expect(levels.getByRole("checkbox", { name: /^A2/ })).toBeChecked();
    await expect(
      levels.getByRole("checkbox", { name: /^B2/ }),
    ).not.toBeChecked();
    await levels.getByLabel("Max hours a week").fill("7.3");
    await levels.getByRole("button", { name: "Save levels and hours" }).click();
    await expect(
      levels.getByText("Enter hours from 0.25 to 100, in quarter hours."),
    ).toBeVisible();
    await levels.getByLabel("Max hours a week").fill("7.5");
    await levels.getByRole("button", { name: "Save levels and hours" }).click();
    await expect(
      page.getByText(`Levels and hours of ${teacherName} saved.`),
    ).toBeVisible();

    await page.goto(`/admin/teachers?q=${encodeURIComponent(teacherName)}`);
    await expect(
      page.getByRole("row").filter({ hasText: teacherName }),
    ).toContainText("A1–B1");
  });

  test("give a group lesson times, assign teachers and publish", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await signIn(page, own.adminEmail);
    await page.waitForURL("/admin");

    // ① The new group has no lesson times yet: it is skipped.
    await page.goto(`/admin/timetable/generate?term=${termId}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Assign teachers",
    );
    const readiness = page.getByTestId("readiness-table");
    const groupRow = readiness.getByRole("row").filter({ hasText: groupName });
    await expect(groupRow).toContainText("No lesson times");

    // Give it a lesson time on the group's Details tab.
    await groupRow.getByRole("link", { name: groupName }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(groupName);
    const times = page.getByTestId("lesson-times");
    await times.getByRole("button", { name: "Add lesson time" }).click();
    await times
      .getByRole("combobox", { name: "Day, lesson time 1" })
      .selectOption({ label: "Wednesday" });
    await times
      .getByRole("combobox", { name: "Start, lesson time 1" })
      .selectOption("750");
    await times
      .getByRole("button", { name: "60 minutes for lesson time 1" })
      .click();
    await times
      .getByRole("combobox", { name: "Room, lesson time 1" })
      .selectOption({ label: "Online classroom · online" });
    await expect(times.getByText("1 lesson · 1 h a week.")).toBeVisible();
    await times.getByRole("button", { name: "Save lesson times" }).click();
    await expect(
      page.getByText(`Lesson times of ${groupName} saved.`),
    ).toBeVisible();
    await page.goto(`/admin/groups?q=${encodeURIComponent(groupName)}`);
    await expect(
      page.getByRole("row").filter({ hasText: groupName }),
    ).toContainText("Wed 12:30–13:30");

    // ② Assign teachers for the term.
    await page.goto(`/admin/timetable/generate?term=${termId}`);
    await expect(
      readiness.getByRole("row").filter({ hasText: groupName }),
    ).toContainText("Ready");
    await page.getByRole("button", { name: "Assign teachers…" }).click();
    const assign = page.getByRole("dialog", {
      name: `Assign teachers for ${TERM_NAME}`,
    });
    await expect(
      assign.getByText(
        "When several teachers fit, workloads are kept as even as possible.",
      ),
    ).toBeVisible();
    await assign.getByRole("button", { name: "Assign teachers" }).click();
    await expect(page.getByText(/groups have a teacher\.$/)).toBeVisible({
      timeout: 60_000,
    });
    await expect(page).toHaveURL(/tab=draft/);
    await expect(
      page.getByText("Draft · not visible to teachers or students"),
    ).toBeVisible();

    // Pick the group's teacher by hand: saved to the draft and locked.
    const draftRow = page
      .getByTestId("draft-table")
      .getByRole("row")
      .filter({ hasText: groupName });
    await draftRow
      .getByRole("button", { name: `Teacher for ${groupName}`, exact: true })
      .click();
    const available = page.getByRole("group", { name: "Available" });
    await expect(available).toBeVisible();
    const choice = available.getByRole("button").first();
    const chosen = (await choice.locator("span").first().innerText())
      .replace(" ✓", "")
      .trim();
    await choice.click();
    await expect(
      page.getByText(`${chosen} now teaches ${groupName} (locked).`),
    ).toBeVisible();
    await expect(
      draftRow.getByRole("button", { name: `Lock teacher for ${groupName}` }),
    ).toHaveAttribute("aria-pressed", "true");

    // The workload view lists the teacher with the group.
    await page.getByRole("button", { name: "By teacher" }).click();
    await expect(
      page.getByTestId("workload-table").getByRole("row").filter({
        hasText: chosen,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "By group" }).click();

    // ③ Publish: confirm the warnings, then the term goes live.
    await page.getByRole("button", { name: "Publish…" }).click();
    const publish = page.getByRole("dialog", {
      name: `Publish teacher assignments for ${TERM_NAME}?`,
    });
    await expect(publish.getByTestId("publish-summary")).toBeVisible({
      timeout: 30_000,
    });
    const acks = publish.getByRole("checkbox");
    for (let i = 0; i < (await acks.count()); i++) await acks.nth(i).check();
    await publish.getByRole("button", { name: "Publish timetable" }).click();
    await expect(
      page.getByText(new RegExp(`^${TERM_NAME} published\\.`)),
    ).toBeVisible({
      timeout: 60_000,
    });
    await expect(page).toHaveURL(/\/admin\/timetable\/edit\?term=/);

    const [slot] = await sql<{ teacher: string }>(
      `SELECT u.name AS teacher FROM timetable_slots s
       JOIN groups g ON g.id = s.group_id
       JOIN teacher_profiles t ON t.id = s.teacher_id
       JOIN users u ON u.id = t.user_id
       WHERE s.term_id = $1 AND g.name = $2`,
      [termId, groupName],
    );
    expect(slot.teacher).toBe(chosen);
  });
});
