import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

import {
  DEMO_LOGINS,
  insertOwnSchool,
  removeSchool,
  signIn,
  sql,
  usersOf,
} from "../helpers";

async function rowCodes(page: Page) {
  return page
    .getByRole("row")
    .locator("td:nth-child(2)")
    .allInnerTexts()
    .then((texts) => texts.map((text) => text.trim()));
}

async function openMenu(page: Page, code: string, item: string | RegExp) {
  await page.getByRole("button", { name: `Actions for ${code}` }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test.describe("admin › skill levels", () => {
  // The reorder test runs in a school of its own: Move up swaps with the
  // nearest level, and other specs add levels to the seeded school while
  // it runs (E2E-LEAK, E2E-P3-…).
  let own: Awaited<ReturnType<typeof insertOwnSchool>>;

  test.beforeAll(async () => {
    own = await insertOwnSchool(randomUUID().slice(0, 8), "Lea Levels");
    await sql(
      `INSERT INTO levels (id, school_id, code, name, rank, updated_at)
       VALUES (gen_random_uuid(), $1, 'A1', 'Beginner', 1, now())`,
      [own.school],
    );
  });

  test.afterAll(async () => {
    const users = await usersOf(own.school);
    await removeSchool(own.school);
    await sql("DELETE FROM users WHERE id = ANY($1::uuid[])", [users]);
  });

  test("create, reorder, archive, restore and delete levels", async ({
    page,
  }) => {
    const stamp = String(Date.now()).slice(-6);
    const first = `X${stamp}`;
    const second = `Y${stamp}`;
    await signIn(page, own.adminEmail);
    await page.waitForURL("/admin");
    await page.goto("/admin/levels");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Skill levels",
    );

    // Create two levels; new levels go last.
    const dialog = page.getByRole("dialog", { name: "New level" });
    for (const code of [first, second]) {
      await page.getByRole("button", { name: "New level" }).click();
      await dialog.getByLabel("Code").fill(code);
      await dialog.getByLabel("Name").fill(`E2E level ${code}`);
      await dialog.getByRole("button", { name: "Create level" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText(`${code} created`)).toBeVisible();
    }
    // The toast shows before the revalidated list renders, so read the rows
    // until both are there.
    let codes: string[] = [];
    await expect(async () => {
      codes = await rowCodes(page);
      expect(codes).toContain(first);
      expect(codes.indexOf(second)).toBe(codes.indexOf(first) + 1);
    }).toPass();

    // Codes are unique, case-insensitively.
    await page.getByRole("button", { name: "New level" }).click();
    await dialog.getByLabel("Code").fill(first.toLowerCase());
    await dialog.getByLabel("Name").fill("Duplicate");
    await dialog.getByRole("button", { name: "Create level" }).click();
    await expect(
      dialog.getByText(`Code "${first.toLowerCase()}" is already used.`),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // Move the second one up: they swap.
    await openMenu(page, second, "Move up");
    await expect(page.getByText(`${second} moved`)).toBeVisible();
    await expect(async () => {
      codes = await rowCodes(page);
      expect(codes.indexOf(second)).toBe(codes.indexOf(first) - 1);
    }).toPass();

    // Archive → hidden from Active, shown under Archived with a badge.
    await openMenu(page, first, "Archive");
    const archive = page.getByRole("alertdialog", {
      name: `Archive ${first}?`,
    });
    await expect(archive).toContainText(
      "0 students and 0 groups keep this level.",
    );
    await archive.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText(`${first} archived`)).toBeVisible();
    await expect(
      page.getByRole("row", { name: new RegExp(first) }),
    ).toHaveCount(0);
    await page.getByLabel("Status").selectOption("archived");
    await expect(
      page.getByRole("row", { name: new RegExp(first) }),
    ).toContainText("Archived");

    // Restore brings it back.
    await openMenu(page, first, "Restore");
    await page
      .getByRole("alertdialog", { name: `Restore ${first}?` })
      .getByRole("button", { name: "Restore" })
      .click();
    await expect(page.getByText(`${first} restored`)).toBeVisible();
    await page.getByLabel("Status").selectOption("active");
    await expect(
      page.getByRole("row", { name: new RegExp(first) }),
    ).toHaveCount(1);

    // Unused levels can be deleted.
    for (const code of [first, second]) {
      await openMenu(page, code, /^Delete/);
      await page
        .getByRole("alertdialog", { name: `Delete ${code}?` })
        .getByRole("button", { name: "Delete" })
        .click();
      await expect(page.getByText(`${code} deleted`)).toBeVisible();
    }
  });

  test("levels in use can't be deleted", async ({ page }) => {
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto("/admin/levels");
    await page.getByRole("button", { name: "Actions for A1" }).click();
    await expect(
      page.getByRole("menuitem", { name: /^Delete/ }),
    ).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("menuitem", { name: /^Delete/ })).toContainText(
      /In use by \d+ records/,
    );
  });
});
