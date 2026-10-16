import { expect, test } from "@playwright/test";

import { hashPassword } from "../src/server/auth/password";
import {
  DEMO_LOGINS,
  DEMO_PASSWORD,
  expectDashboard,
  signIn,
  sql,
} from "./helpers";

test.describe("sign in", () => {
  for (const [role, path, name] of [
    ["admin", "/admin", "Alexandra"],
    ["teacher", "/teacher", "Jana"],
    ["student", "/student", "Adam"],
  ] as const) {
    test(`${role} lands on their dashboard`, async ({ page }) => {
      await signIn(page, DEMO_LOGINS[role]);
      await expectDashboard(page, path);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(name);
      await expect(page.getByTestId("school-name")).toHaveText(
        "Demo Language School",
      );
      await expect(page.getByRole("main")).toBeVisible();
    });
  }

  test("wrong password shows an error and clears the password", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.admin, "not-the-password");
    await expect(
      page.getByRole("alert").filter({ hasText: "Email or password" }),
    ).toHaveText("Email or password is incorrect.");
    await expect(page).toHaveURL("/login");
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  });

  test("validates the fields before submitting", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Enter your email.")).toBeVisible();
    await expect(page.getByText("Enter your password.")).toBeVisible();
  });

  test("returns to the requested page after sign-in", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL("/login?callbackUrl=%2Fadmin");
    await signIn(page, DEMO_LOGINS.admin);
    await expectDashboard(page, "/admin");
  });

  test("ignores a callback into another role's area", async ({ page }) => {
    await page.goto("/login?callbackUrl=%2Fadmin");
    await signIn(page, DEMO_LOGINS.student);
    await expectDashboard(page, "/student");
  });

  test("signed-in users skip the login page", async ({ page }) => {
    await signIn(page, DEMO_LOGINS.teacher);
    await expectDashboard(page, "/teacher");
    await page.goto("/login");
    await expectDashboard(page, "/teacher");
  });

  test("sign out ends the session", async ({ page }) => {
    // No link prefetches: the proxy rolls the session cookie on every
    // response, so a prefetch still in flight when the user signs out lands
    // afterwards and sets the cookie again. That race is a product
    // follow-up (CARM-67), not what this test is about.
    await page.route("**/*", (route) =>
      route.request().headers()["next-router-prefetch"]
        ? route.abort()
        : route.fallback(),
    );
    await signIn(page, DEMO_LOGINS.teacher);
    await expectDashboard(page, "/teacher");
    await page.getByRole("button", { name: /Account menu/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/login");
    await page.goto("/teacher");
    await expect(page).toHaveURL("/login?callbackUrl=%2Fteacher");
  });
});

test.describe("role areas", () => {
  test("a student cannot open admin or teacher pages", async ({ page }) => {
    await signIn(page, DEMO_LOGINS.student);
    await expectDashboard(page, "/student");

    for (const path of ["/admin", "/admin/students", "/teacher"]) {
      await page.goto(path);
      await expect(page).toHaveURL(path);
      await expect(
        page.getByRole("heading", {
          name: "You don't have access to this page",
        }),
      ).toBeVisible();
      await expect(page.getByTestId("school-name")).toHaveCount(0);
    }

    await page.getByRole("link", { name: "Go to my dashboard" }).click();
    await expectDashboard(page, "/student");
  });

  test("a teacher cannot open admin pages", async ({ page }) => {
    await signIn(page, DEMO_LOGINS.teacher);
    await expectDashboard(page, "/teacher");
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "You don't have access to this page" }),
    ).toBeVisible();
    await expect(page.getByTestId("school-name")).toHaveCount(0);
  });

  test("signed-out visitors are sent to login from every area", async ({
    page,
  }) => {
    for (const path of ["/admin", "/teacher", "/student"]) {
      await page.goto(path);
      await expect(page).toHaveURL(
        `/login?callbackUrl=${encodeURIComponent(path)}`,
      );
    }
  });
});

// A second school with its own admin; ids are fixed so reruns converge.
const OTHER_SCHOOL_ID = "00000000-0000-4000-8000-0000000c0019";
const OTHER_USER_ID = "00000000-0000-4000-8000-0000000c0020";
const OTHER_MEMBERSHIP_ID = "00000000-0000-4000-8000-0000000c0021";
const OTHER_EMAIL = "admin@other-school.test";

test.describe("cross-school access", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const hash = await hashPassword(DEMO_PASSWORD);
    await sql(
      `INSERT INTO schools (id, name, slug, timezone, updated_at)
       VALUES ($1, 'Other Language School', 'e2e-other-school', 'Europe/London', now())
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_SCHOOL_ID],
    );
    await sql(
      `INSERT INTO users (id, email, name, password_hash, updated_at)
       VALUES ($1, $2, 'Olga Other', $3, now())
       ON CONFLICT (id) DO UPDATE SET password_hash = $3, deleted_at = NULL`,
      [OTHER_USER_ID, OTHER_EMAIL, hash],
    );
    await sql(`DELETE FROM memberships WHERE user_id = $1`, [OTHER_USER_ID]);
    await sql(
      `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
       VALUES ($1, $2, $3, 'ADMIN', now())`,
      [OTHER_MEMBERSHIP_ID, OTHER_SCHOOL_ID, OTHER_USER_ID],
    );
  });

  test.afterAll(async () => {
    await sql(`DELETE FROM memberships WHERE user_id = $1`, [OTHER_USER_ID]);
    await sql(`DELETE FROM users WHERE id = $1`, [OTHER_USER_ID]);
    await sql(`DELETE FROM schools WHERE id = $1`, [OTHER_SCHOOL_ID]);
  });

  test("an admin only sees their own school", async ({ page }) => {
    await signIn(page, OTHER_EMAIL);
    await expectDashboard(page, "/admin");
    await expect(page.getByTestId("school-name")).toHaveText(
      "Other Language School",
    );
    // Hidden copies of earlier routes (e.g. /login) may stay in the DOM.
    await expect(
      page.getByText("Demo Language School").filter({ visible: true }),
    ).toHaveCount(0);
  });

  test("a session for a school the user no longer belongs to is denied", async ({
    page,
  }) => {
    await signIn(page, OTHER_EMAIL);
    await expectDashboard(page, "/admin");

    // Move the membership to the demo school while the session (issued for
    // the other school) is still valid.
    await sql(
      `UPDATE memberships SET school_id = (SELECT id FROM schools WHERE slug = 'demo-language-school')
       WHERE id = $1`,
      [OTHER_MEMBERSHIP_ID],
    );
    try {
      await page.goto("/admin");
      await expect(page).toHaveURL("/login?reason=expired");
      await expect(page.getByText("Your session expired.")).toBeVisible();
    } finally {
      await sql(`UPDATE memberships SET school_id = $1 WHERE id = $2`, [
        OTHER_SCHOOL_ID,
        OTHER_MEMBERSHIP_ID,
      ]);
    }
  });
});
