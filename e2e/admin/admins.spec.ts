import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { DEMO_LOGINS, signIn } from "../helpers";

test.describe("admin › administrators", () => {
  test("create, set password, archive and restore an admin", async ({
    page,
  }) => {
    const stamp = randomUUID().slice(0, 8);
    const name = `E2E Admin ${stamp}`;
    const email = `e2e.admin.${stamp}@example.test`;
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto("/admin/settings/admins");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Administrators",
    );

    // Own row: "You" badge, no Archive.
    const own = page.getByRole("row", { name: new RegExp(DEMO_LOGINS.admin) });
    await expect(own).toContainText("You");
    await own.getByRole("button", { name: /^Actions for / }).click();
    await expect(
      page.getByRole("menuitem", { name: "Set new password" }),
    ).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Archive" })).toHaveCount(
      0,
    );
    await page.keyboard.press("Escape");

    // Create → credentials dialog.
    await page.getByRole("button", { name: "New administrator" }).click();
    const dialog = page.getByRole("dialog", { name: "New administrator" });
    await dialog.getByLabel("Full name").fill(name);
    await dialog.getByLabel("Email").fill(email);
    await dialog.getByLabel("Password", { exact: true }).fill("short");
    await dialog.getByRole("button", { name: "Create administrator" }).click();
    await expect(dialog.getByText("Use at least 10 characters.")).toBeVisible();
    await dialog
      .getByLabel("Password", { exact: true })
      .fill("a-long-password-1");
    await dialog.getByRole("button", { name: "Create administrator" }).click();
    const credentials = page.getByRole("dialog", {
      name: "Share these sign-in details",
    });
    await expect(credentials.getByTestId("credentials")).toContainText(
      "a-long-password-1",
    );
    await credentials.getByRole("button", { name: "Done" }).click();

    // Set a new password from the row menu.
    await page
      .getByRole("searchbox", { name: "Search by name or email" })
      .fill(name);
    await expect(page.getByRole("row")).toHaveCount(2);
    await page.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Set new password" }).click();
    const password = page.getByRole("dialog", {
      name: `Set a new password for ${name}`,
    });
    await password.getByRole("button", { name: "Generate" }).click();
    await password.getByRole("button", { name: "Save" }).click();
    await expect(credentials.getByTestId("credentials")).toContainText(email);
    await credentials.getByRole("button", { name: "Done" }).click();

    // Archive, then restore from the Archived filter.
    await page.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await page
      .getByRole("alertdialog", { name: `Archive ${name}?` })
      .getByRole("button", { name: "Archive" })
      .click();
    await expect(page.getByText(`${name} archived`)).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(0);
    await page.getByLabel("Status").selectOption("archived");
    await page.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Restore" }).click();
    await page
      .getByRole("alertdialog", { name: `Restore ${name}?` })
      .getByRole("button", { name: "Restore" })
      .click();
    await expect(page.getByText(`${name} restored`)).toBeVisible();
  });
});
