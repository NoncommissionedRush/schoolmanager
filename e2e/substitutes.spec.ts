import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  addDays,
  toZonedDateTime,
  zonedTimeToUtc,
} from "../src/server/scheduling/time";
import { currentTermId, DEMO_LOGINS, signIn, sql } from "./helpers";

// Happy path of CARM-65 substitutes (docs/design/notifications-substitutes.md
// §5): a teacher is away on a lesson's date, so the lesson needs cover; the
// admin finds a substitute in the sheet and assigns them; the substitute
// sees it on their dashboard, in the bell and on their Substitutions page,
// and the regular teacher sees who covers. Runs on its own teachers, group,
// student and lesson.
test.describe("substitutes › find, assign and see the cover", () => {
  test.describe.configure({ mode: "serial" });
  const TZ = "Europe/Bratislava";
  const suffix = randomUUID().slice(0, 8);
  const group = `E2E Cover ${suffix}`;
  const regularEmail = `e2e-cover-r-${suffix}@demo-school.test`;
  const substituteEmail = `e2e-cover-s-${suffix}@demo-school.test`;
  const regularName = `Rita Regular ${suffix}`;
  const substituteName = `Sam Substitute ${suffix}`;
  const ids = {
    term: "",
    school: "",
    group: randomUUID(),
    regularUser: randomUUID(),
    regular: randomUUID(),
    substituteUser: randomUUID(),
    substitute: randomUUID(),
    studentUser: randomUUID(),
    student: randomUUID(),
    lesson: randomUUID(),
  };
  const today = toZonedDateTime(new Date(), TZ).date;
  const date = addDays(today, 3);
  // 06:00–06:45: outside every seeded lesson, so the substitute is free.
  const startsAt = zonedTimeToUtc(date, 6 * 60, TZ);

  test.beforeAll(async () => {
    const [row] = await sql<{ school: string; level: string; hash: string }>(
      `SELECT s.id AS school, g.level_id AS level, su.password_hash AS hash
       FROM schools s
       JOIN groups g ON g.school_id = s.id AND g.name = 'A2 Evening'
       JOIN users su ON su.email = $1
       WHERE s.slug = 'demo-language-school'`,
      [DEMO_LOGINS.student],
    );
    ids.school = row.school;
    ids.term = await currentTermId(row.school, today, date);
    await sql(
      `INSERT INTO users (id, email, name, password_hash, updated_at)
       VALUES ($1, $2, $3, $7, now()), ($4, $5, $6, $7, now()),
              ($8, $9, 'Stella Student', $7, now())`,
      [
        ids.regularUser,
        regularEmail,
        regularName,
        ids.substituteUser,
        substituteEmail,
        substituteName,
        row.hash,
        ids.studentUser,
        `e2e-cover-st-${suffix}@demo-school.test`,
      ],
    );
    await sql(
      `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'TEACHER', now()),
              (gen_random_uuid(), $1, $3, 'TEACHER', now()),
              (gen_random_uuid(), $1, $4, 'STUDENT', now())`,
      [row.school, ids.regularUser, ids.substituteUser, ids.studentUser],
    );
    await sql(
      `INSERT INTO teacher_profiles (id, school_id, user_id, updated_at)
       VALUES ($1, $3, $2, now()), ($4, $3, $5, now())`,
      [
        ids.regular,
        ids.regularUser,
        row.school,
        ids.substitute,
        ids.substituteUser,
      ],
    );
    await sql(
      `INSERT INTO teacher_levels (id, school_id, teacher_id, level_id)
       VALUES (gen_random_uuid(), $1, $2, $4), (gen_random_uuid(), $1, $3, $4)`,
      [row.school, ids.regular, ids.substitute, row.level],
    );
    await sql(
      `INSERT INTO student_profiles (id, school_id, user_id, level_id, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [ids.student, row.school, ids.studentUser, row.level],
    );
    await sql(
      `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at)
       VALUES ($1, $2, $3, 'GROUP', $4, 8, now())`,
      [ids.group, row.school, row.level, group],
    );
    await sql(
      `INSERT INTO group_memberships (id, school_id, group_id, student_id, joined_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now() - interval '1 day', now())`,
      [row.school, ids.group, ids.student],
    );
    await sql(
      `INSERT INTO lessons (id, school_id, term_id, group_id, teacher_id, starts_at, ends_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '45 minutes', now())`,
      [ids.lesson, row.school, ids.term, ids.group, ids.regular, startsAt],
    );
    // The regular teacher is away that day.
    await sql(
      `INSERT INTO teacher_availability (id, school_id, teacher_id, kind, date, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'DATE_UNAVAILABLE', $3, now())`,
      [row.school, ids.regular, date],
    );
  });

  test.afterAll(async () => {
    await sql("DELETE FROM lessons WHERE id = $1", [ids.lesson]);
    await sql("DELETE FROM group_memberships WHERE group_id = $1", [ids.group]);
    await sql("DELETE FROM groups WHERE id = $1", [ids.group]);
    await sql("DELETE FROM student_profiles WHERE id = $1", [ids.student]);
    await sql("DELETE FROM teacher_availability WHERE teacher_id = $1", [
      ids.regular,
    ]);
    await sql("DELETE FROM teacher_levels WHERE teacher_id = ANY($1)", [
      [ids.regular, ids.substitute],
    ]);
    await sql("DELETE FROM teacher_profiles WHERE id = ANY($1)", [
      [ids.regular, ids.substitute],
    ]);
    const users = [ids.regularUser, ids.substituteUser, ids.studentUser];
    await sql("DELETE FROM memberships WHERE user_id = ANY($1)", [users]);
    await sql("DELETE FROM users WHERE id = ANY($1)", [users]);
  });

  test("the admin covers the lesson and both teachers see it", async ({
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const page = await adminContext.newPage();
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");

    // Needs cover, filtered to the regular teacher.
    await page.goto(`/admin/substitutions?teacher=${ids.regular}`);
    const table = page.getByTestId("substitutions-needsCover");
    const row = table.getByRole("row").filter({ hasText: group });
    await expect(row).toContainText(regularName);
    await expect(row).toContainText("Away (one-off)");
    await row.getByRole("button", { name: "Find substitute" }).click();

    const sheet = page.getByRole("dialog", { name: "Find a substitute" });
    await expect(sheet.getByTestId("sheet-lesson")).toContainText(group);
    await expect(
      sheet.getByText(`Regular teacher: ${regularName} (Away (one-off))`),
    ).toBeVisible();
    const suggested = sheet.getByRole("group", { name: /^Suggested/ });
    await suggested.getByText(substituteName).click();
    await expect(sheet.getByTestId("notify-preview")).toContainText(
      `${substituteName}, ${regularName} and 1 student of ${group} will be notified.`,
    );
    await sheet
      .getByRole("button", { name: `Assign ${substituteName}` })
      .click();
    await expect(
      page.getByText(
        new RegExp(`^${substituteName} is substituting in ${group} on `),
      ),
    ).toBeVisible();

    // It moved to Covered.
    await page.goto(`/admin/substitutions?tab=covered&teacher=${ids.regular}`);
    const covered = page
      .getByTestId("substitutions-covered")
      .getByRole("row")
      .filter({ hasText: group });
    await expect(covered).toContainText(substituteName);
    await adminContext.close();

    // The substitute: bell, dashboard card, Substitutions page.
    const subContext = await browser.newContext();
    const sub = await subContext.newPage();
    await signIn(sub, substituteEmail);
    await sub.waitForURL("/teacher");
    await expect(
      sub.getByRole("button", { name: "Notifications, 1 unread" }),
    ).toBeVisible();
    await expect(
      sub.getByText("You're covering 1 lesson in the next 14 days"),
    ).toBeVisible();
    await sub.getByRole("link", { name: "Substitutions", exact: true }).click();
    await sub.waitForURL("/teacher/substitutions");
    const covering = sub.getByTestId("substitutions-covering");
    await expect(covering).toContainText(group);
    await expect(covering).toContainText(`for ${regularName}`);
    await subContext.close();

    // The regular teacher: covered for them, and told about it.
    const regContext = await browser.newContext();
    const reg = await regContext.newPage();
    await signIn(reg, regularEmail);
    await reg.waitForURL("/teacher");
    await reg.goto("/teacher/notifications");
    await expect(
      reg.getByText(
        new RegExp(
          `^Unread: ${substituteName} is covering your ${group} lesson on `,
        ),
      ),
    ).toBeVisible();
    await reg.goto("/teacher/substitutions");
    await expect(reg.getByTestId("substitutions-coveredForMe")).toContainText(
      `by ${substituteName}`,
    );
    await regContext.close();
  });
});
