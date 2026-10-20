import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { DEMO_LOGINS, signIn } from "../helpers";

test.describe("admin › rooms", () => {
  test("create, edit, archive and restore a room", async ({ page }) => {
    const name = `E2E Room ${randomUUID().slice(0, 8)}`;
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto("/admin/settings/rooms");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rooms");

    // Create: validation first, then a valid physical room.
    await page.getByRole("button", { name: "New room" }).click();
    const dialog = page.getByRole("dialog", { name: "New room" });
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByRole("button", { name: "Create room" }).click();
    await expect(
      dialog.getByText("Enter a whole number from 1 to 500."),
    ).toBeVisible();
    await dialog.getByLabel("Capacity").fill("12");
    await dialog.getByRole("button", { name: "Create room" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`${name} created`)).toBeVisible();

    // Duplicate names are rejected by the server.
    await page.getByRole("button", { name: "New room" }).click();
    await dialog.getByLabel("Name").fill(name.toLowerCase());
    await dialog.getByLabel("Capacity").fill("5");
    await dialog.getByRole("button", { name: "Create room" }).click();
    await expect(dialog.getByText(/is already used/)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // Search, then edit into an online room.
    await page.getByRole("searchbox", { name: "Search rooms" }).fill(name);
    await expect(page.getByRole("row")).toHaveCount(2);
    await page.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const edit = page.getByRole("dialog", { name: "Edit room" });
    await edit.getByLabel("Online room").check();
    await edit.getByLabel("Meeting link").fill("http://insecure.test");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(
      edit.getByText("Enter a link starting with https://"),
    ).toBeVisible();
    await edit.getByLabel("Meeting link").fill("https://meet.example.com/abc");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(edit).toBeHidden();
    await expect(
      page.getByRole("link", { name: /meet\.example\.com/ }),
    ).toBeVisible();

    // Archive → disappears from the active list; restore from Archived.
    await page.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await page
      .getByRole("alertdialog", { name: `Archive ${name}?` })
      .getByRole("button", { name: "Archive" })
      .click();
    await expect(page.getByText(`${name} archived`)).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(0);
    await page.getByLabel("Status").selectOption("archived");
    await expect(
      page.getByRole("row", { name: new RegExp(name) }),
    ).toContainText("Archived");
    await page.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page
      .getByRole("alertdialog", { name: `Delete ${name}?` })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(page.getByText(`${name} deleted`)).toBeVisible();
  });

  for (const [role, home] of [
    ["teacher", "/teacher"],
    ["student", "/student"],
  ] as const) {
    // The proxy answers 403 here; permissions/roles.spec asserts the status.
    test(`a ${role} gets the forbidden page`, async ({ page }) => {
      await signIn(page, DEMO_LOGINS[role]);
      await page.waitForURL(home);
      await page.goto("/admin/settings/rooms");
      await expect(
        page.getByRole("heading", {
          name: "You don't have access to this page",
        }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "Rooms" })).toHaveCount(0);
    });
  }
});
