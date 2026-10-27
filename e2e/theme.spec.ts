import { expect, test } from "@playwright/test";

import { DEMO_LOGINS, expectDashboard, signIn } from "./helpers";

test.describe("theme", () => {
  test.use({ colorScheme: "light" });

  test("follows the system preference by default", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/login");
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  });

  test("the user menu switches to dark mode and the choice persists", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.teacher);
    await expectDashboard(page, "/teacher");
    const html = page.locator("html");
    await expect(html).not.toHaveClass(/\bdark\b/);

    await page.getByRole("button", { name: /Account menu/ }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(html).toHaveClass(/\bdark\b/);

    await page.reload();
    await expect(html).toHaveClass(/\bdark\b/);

    await page.getByRole("button", { name: /Account menu/ }).click();
    await expect(
      page.getByRole("menuitemradio", { name: "Dark" }),
    ).toBeChecked();
    await page.getByRole("menuitemradio", { name: "Light" }).click();
    await expect(html).not.toHaveClass(/\bdark\b/);
  });
});
