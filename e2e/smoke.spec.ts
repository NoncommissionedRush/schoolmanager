import { expect, test } from "@playwright/test";

test("home sends signed-out visitors to the login page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/login");
  await expect(
    page.getByRole("heading", { level: 1, name: "Sign in" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-GB");
  await expect(page).toHaveTitle("School Manager");
});

test("health endpoint reports a reachable database", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ status: "ok", database: "ok" });
});
