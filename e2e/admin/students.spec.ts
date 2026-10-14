import { expect, test } from "@playwright/test";

import { DEMO_LOGINS, signIn } from "../helpers";

test.describe("admin › students", () => {
  test("create a student in a group, then remove them from it", async ({
    page,
  }) => {
    const stamp = Date.now();
    const name = `E2E Student ${stamp}`;
    const email = `e2e.student.${stamp}@example.test`;
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto("/admin/students");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Students",
    );

    // Create with a level and a group of that level.
    await page.getByRole("button", { name: "New student" }).click();
    const dialog = page.getByRole("dialog", { name: "New student" });
    await dialog.getByLabel("Full name").fill(name);
    await dialog.getByLabel("Email").fill(email);
    await dialog.getByRole("button", { name: "Generate" }).click();
    await dialog
      .getByLabel(/^Level/)
      .selectOption({ label: "B1 · Intermediate" });
    const group = dialog.getByLabel(/^Add to group/);
    const option = group.locator("option").nth(1);
    const groupName = (await option.textContent())!.replace(/ \(.*$/, "");
    expect(groupName).toMatch(/B1/);
    await group.selectOption({ index: 1 });
    await dialog.getByRole("button", { name: "Create student" }).click();

    // Credentials are shown once.
    const credentials = page.getByRole("dialog", {
      name: "Share these sign-in details",
    });
    await expect(credentials.getByTestId("credentials")).toContainText(email);
    await credentials.getByRole("button", { name: "Done" }).click();

    // Find them in the list (search) and open the detail page.
    await page
      .getByRole("searchbox", { name: "Search by name, email or phone" })
      .fill(email);
    // Wait for the debounced search to land before clicking a row.
    await page.waitForURL(/[?&]q=/);
    await expect(page.getByRole("row")).toHaveCount(2);
    const row = page.getByRole("row", { name: new RegExp(name) });
    await expect(row).toContainText("B1");
    await expect(row).toContainText(groupName);
    await row.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);

    // Profile tab: saving twice works (fresh `updatedAt` after each save).
    await page.getByLabel(/^Phone/).fill("+421 900 000 001");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Changes saved")).toBeVisible();
    await page.getByLabel(/^Phone/).fill("+421 900 000 002");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Changes saved").first()).toBeVisible();
    await expect(
      page.getByText(/Someone else changed this record/),
    ).toHaveCount(0);

    // Groups tab: remove from the group → listed under Past groups.
    await page.getByRole("tab", { name: "Groups" }).click();
    await page
      .getByRole("button", { name: `Remove from ${groupName}` })
      .click();
    const remove = page.getByRole("dialog", {
      name: `Remove ${name} from ${groupName}?`,
    });
    await expect(remove.getByLabel("Last day in the group")).toBeVisible();
    await remove.getByRole("button", { name: "Remove from group" }).click();
    await expect(
      page.getByText(`${name} removed from ${groupName}`),
    ).toBeVisible();
    await expect(page.getByTestId("past-groups")).toContainText(groupName);
    await expect(
      page.getByText(`${name} isn't in any group yet.`),
    ).toBeVisible();

    // The list's "Not in any group" filter now finds them.
    await page.goto(
      `/admin/students?group=none&q=${encodeURIComponent(email)}`,
    );
    await expect(
      page.getByRole("row", { name: new RegExp(name) }),
    ).toBeVisible();
  });

  for (const [role, home] of [
    ["teacher", "/teacher"],
    ["student", "/student"],
  ] as const) {
    // The status isn't asserted: the shell streams before the role check,
    // so production answers 200 with the forbidden page (as in auth.spec).
    test(`a ${role} gets the forbidden page`, async ({ page }) => {
      await signIn(page, DEMO_LOGINS[role]);
      await page.waitForURL(home);
      await page.goto("/admin/students");
      await expect(
        page.getByRole("heading", {
          name: "You don't have access to this page",
        }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "Students" })).toHaveCount(
        0,
      );
    });
  }
});
