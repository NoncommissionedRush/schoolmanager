import { expect, test } from "@playwright/test";

import { DEMO_LOGINS, signIn } from "../helpers";

test.describe("admin › groups", () => {
  test("create a group, fill it up to capacity, then a 1-on-1", async ({
    page,
  }) => {
    const stamp = Date.now();
    const name = `E2E Group ${stamp}`;
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto("/admin/groups");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Courses & groups",
    );

    // Create a group lesson with capacity 2.
    await page.getByRole("button", { name: "New group" }).click();
    const dialog = page.getByRole("dialog", { name: "New group" });
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByLabel(/^Level/).selectOption({ label: "A1 · Beginner" });
    await dialog.getByRole("button", { name: "Create group" }).click();
    await expect(
      dialog.getByText("Enter a whole number from 1 to 100."),
    ).toBeVisible();
    await dialog.getByLabel("Capacity").fill("2");
    await dialog.getByRole("button", { name: "Create group" }).click();
    await expect(page.getByText(`${name} created`)).toBeVisible();

    // Open it and add members up to the capacity.
    await page.getByRole("searchbox", { name: "Search groups" }).fill(name);
    // Wait for the debounced search to land before clicking a row.
    await page.waitForURL(/[?&]q=/);
    await expect(page.getByRole("row")).toHaveCount(2);
    await page.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    await expect(page.getByText("2 places left")).toBeVisible();
    await page.getByRole("button", { name: "Add members" }).click();
    const add = page.getByRole("dialog", { name: `Add members to ${name}` });
    await add.getByLabel("Show all levels").check();
    // Leave the demo student login alone.
    const choices = add
      .getByRole("listitem")
      .filter({ hasNot: page.getByText(DEMO_LOGINS.student) })
      .getByRole("checkbox");
    await choices.nth(0).check();
    await choices.nth(1).check();
    await expect(
      add.getByText("The group is full. Increase the capacity to add more."),
    ).toBeVisible();
    await expect(choices.nth(2)).toBeDisabled();
    await add.getByRole("button", { name: "Add members" }).click();
    await expect(page.getByText(`2 students added to ${name}`)).toBeVisible();
    await expect(page.getByText("Members 2 / 2")).toBeVisible();
    await expect(page.getByText("No places left")).toBeVisible();

    // Capacity can't go below the member count.
    await page.getByRole("tab", { name: "Details" }).click();
    await page.getByLabel("Capacity").fill("1");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByText(
        "This group already has 2 members. Remove members first or choose at least 2.",
      ),
    ).toBeVisible();

    // A 1-on-1: capacity fixed at 1, name prefilled from the student.
    await page.goto("/admin/groups");
    await page.getByRole("button", { name: "New group" }).click();
    const one = page.getByRole("dialog", { name: "New group" });
    // Blurring the empty Name shows its error and re-centres the dialog,
    // which would move the radio mid-click: let that happen first.
    await one.getByLabel("1-on-1").focus();
    await expect(one.getByText("Enter a value.")).toBeVisible();
    await one.getByLabel("1-on-1").check();
    await expect(one.getByLabel("Capacity")).toHaveValue("1");
    await expect(
      one.getByText("1-on-1 lessons have one student."),
    ).toBeVisible();
    const student = one.getByLabel(/^Student/);
    await student.selectOption({ index: 1 });
    await expect(one.getByLabel("Name")).toHaveValue(/ 1-on-1$/);
    const oneName = `E2E 1-on-1 ${stamp}`;
    await one.getByLabel("Name").fill(oneName);
    await one.getByRole("button", { name: "Create group" }).click();
    await expect(page.getByText(`${oneName} created`)).toBeVisible();
    await page.getByRole("searchbox", { name: "Search groups" }).fill(oneName);
    // Wait for the debounced search to land before clicking a row.
    await page.waitForURL(/[?&]q=/);
    const row = page.getByRole("row", { name: new RegExp(oneName) });
    await expect(row).toContainText("1-on-1");
    await expect(row).toContainText("1 / 1");
    await expect(row).toContainText("Full");
  });

  test("a group with running slots can't be archived", async ({ page }) => {
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto("/admin/groups");
    await page.getByRole("button", { name: "Actions for A1 Morning" }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await page
      .getByRole("alertdialog", { name: "Archive A1 Morning?" })
      .getByRole("button", { name: "Archive" })
      .click();
    const blocked = page.getByRole("alertdialog", {
      name: "A1 Morning can't be archived yet",
    });
    await expect(blocked).toContainText("End them in the timetable first.");
    await expect(
      blocked.getByRole("link", { name: "Open in timetable editor" }),
    ).toBeVisible();
  });

  test("courses: create, then delete while unused", async ({ page }) => {
    const name = `E2E Course ${Date.now()}`;
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto("/admin/groups?tab=courses");
    await page.getByRole("button", { name: "New course" }).click();
    const dialog = page.getByRole("dialog", { name: "New course" });
    await dialog.getByLabel("Name").fill(name);
    await dialog
      .getByLabel(/^Level/)
      .selectOption({ label: "B2 · Upper intermediate" });
    await dialog.getByRole("button", { name: "Create course" }).click();
    await expect(page.getByText(`${name} created`)).toBeVisible();
    await page.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page
      .getByRole("alertdialog", { name: `Delete ${name}?` })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(page.getByText(`${name} deleted`)).toBeVisible();
  });
});
