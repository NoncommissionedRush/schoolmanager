import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

import { addDays } from "../src/server/scheduling/time";
import { TODAY } from "./clock";
import { DEMO_LOGINS, signIn, sql } from "./helpers";

// Happy path of CARM-86 (docs/design/availability-requests.md): a teacher
// asks for weekly unavailability and a one-off exception; nothing changes
// until an admin decides. The admin approves one and declines the other with
// a note; the teacher sees both outcomes and is told in the bell. Runs on a
// teacher of its own.
test.describe("availability requests › teacher asks, admin decides", () => {
  test.describe.configure({ mode: "serial" });
  const suffix = randomUUID().slice(0, 8);
  const email = `e2e-avail-${suffix}@demo-school.test`;
  const name = `Petra Planner ${suffix}`;
  const ids = { user: randomUUID(), teacher: randomUUID() };
  const exceptionDay = addDays(TODAY, 9);

  test.beforeAll(async () => {
    const [row] = await sql<{ school: string; hash: string }>(
      `SELECT s.id AS school, u.password_hash AS hash
       FROM schools s JOIN users u ON u.email = $1
       WHERE s.slug = 'demo-language-school'`,
      [DEMO_LOGINS.teacher],
    );
    await sql(
      `INSERT INTO users (id, email, name, password_hash, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [ids.user, email, name, row.hash],
    );
    await sql(
      `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'TEACHER', now())`,
      [row.school, ids.user],
    );
    await sql(
      `INSERT INTO teacher_profiles (id, school_id, user_id, updated_at)
       VALUES ($1, $2, $3, now())`,
      [ids.teacher, row.school, ids.user],
    );
  });

  test.afterAll(async () => {
    await sql("DELETE FROM teacher_profiles WHERE id = $1", [ids.teacher]);
    await sql("DELETE FROM memberships WHERE user_id = $1", [ids.user]);
    await sql("DELETE FROM users WHERE id = $1", [ids.user]);
  });

  const card = (page: Page, title: string) =>
    page
      .locator("[data-slot=card]")
      .filter({ has: page.getByRole("heading", { name: title }) });

  test("the teacher sends two changes for approval", async ({ page }) => {
    await signIn(page, email);
    await page.waitForURL("/teacher");
    await page.getByRole("link", { name: "My availability" }).click();
    await page.waitForURL("/teacher/availability");
    await expect(
      page.getByText("You're available during all school hours."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Add unavailable time" }).click();
    const weekly = page.getByRole("dialog", { name: "Add unavailable time" });
    await weekly.getByLabel("Mon", { exact: true }).check();
    await weekly.getByLabel("From").fill("07:00");
    await weekly.getByLabel("To").fill("09:00");
    await weekly.getByRole("button", { name: "Send for approval" }).click();
    await expect(weekly).toBeHidden();
    await expect(page.getByText("Sent for approval")).toBeVisible();

    await page.getByRole("button", { name: "Add exception" }).click();
    const exception = page.getByRole("dialog", { name: "Add exception" });
    await exception.getByLabel("Date", { exact: true }).fill(exceptionDay);
    await exception.getByLabel("Note").fill("Dentist");
    await exception.getByRole("button", { name: "Send for approval" }).click();
    await expect(exception).toBeHidden();

    const requests = card(page, "Your requests");
    await expect(requests).toContainText("Add weekly unavailability");
    await expect(requests).toContainText("Every Monday · 07:00–09:00");
    await expect(requests).toContainText("Add exception");
    await expect(requests).toContainText("Note: Dentist");
    // Nothing applied yet.
    await expect(
      page.getByText("You're available during all school hours."),
    ).toBeVisible();
    await expect(page.getByText("No exceptions planned.")).toBeVisible();
  });

  test("an admin approves one and declines the other", async ({ page }) => {
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await expect(
      page.getByRole("button", { name: /^Notifications, \d+ unread$/ }),
    ).toBeVisible();
    await page.goto(`/admin/teachers/${ids.teacher}?tab=availability`);
    const requests = card(page, "Change requests");
    await expect(requests).toContainText("Petra asked for these changes.");

    await requests
      .getByRole("button", { name: /^Approve: Add weekly unavailability/ })
      .click();
    await page
      .getByRole("alertdialog", { name: "Approve this change?" })
      .getByRole("button", { name: "Approve" })
      .click();
    await expect(page.getByText("Approved and applied")).toBeVisible();
    await expect(
      card(page, "Weekly unavailability").getByText(
        "Every Monday · 07:00–09:00",
      ),
    ).toBeVisible();

    await requests
      .getByRole("button", { name: /^Decline: Add exception/ })
      .click();
    const decline = page.getByRole("dialog", { name: "Decline this change?" });
    await decline.getByLabel("Note to the teacher").fill("Exam week");
    await decline.getByRole("button", { name: "Decline" }).click();
    await expect(page.getByText("Request declined")).toBeVisible();
    await expect(requests).toBeHidden();
    await expect(page.getByText("No exceptions planned.")).toBeVisible();
  });

  test("the teacher sees both outcomes", async ({ page }) => {
    await signIn(page, email);
    await page.waitForURL("/teacher");
    await expect(
      page.getByRole("button", { name: "Notifications, 2 unread" }),
    ).toBeVisible();
    await page.goto("/teacher/availability");
    await expect(
      card(page, "Weekly unavailability").getByText(
        "Every Monday · 07:00–09:00",
      ),
    ).toBeVisible();
    const requests = card(page, "Your requests");
    await expect(
      requests.getByText("No requests waiting for approval."),
    ).toBeVisible();
    await expect(requests).toContainText("Approved");
    await expect(requests).toContainText("Declined");
    await expect(requests).toContainText("School's note: Exam week");
  });
});
