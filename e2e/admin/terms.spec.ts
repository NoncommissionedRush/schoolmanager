import { expect, type Page, test } from "@playwright/test";

import { DEMO_LOGINS, signIn } from "../helpers";

async function openMenu(page: Page, name: string, item: string | RegExp) {
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test.describe("admin › terms & holidays", () => {
  test("create a draft term, add holidays, edit and delete it", async ({
    page,
  }) => {
    const stamp = Date.now();
    const term = `E2E Term ${stamp}`;
    const termHoliday = `E2E Term break ${stamp}`;
    const schoolHoliday = `E2E Public holiday ${stamp}`;
    // Far from the seeded (published) term, so no lessons change.
    const year = 2040 + (stamp % 50);

    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto("/admin/settings/terms");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Terms & holidays",
    );
    await expect(page.getByRole("row", { name: /^Autumn 2026/ })).toContainText(
      "Published",
    );

    // Create: end before start is rejected; an overlap only warns.
    await page.getByRole("button", { name: "New term" }).click();
    const dialog = page.getByRole("dialog", { name: "New term" });
    await dialog.getByLabel("Name").fill(term);
    await dialog.getByLabel("First day").fill("2026-10-01");
    await dialog.getByLabel("Last day").fill("2026-10-31");
    await expect(
      dialog.getByText(
        "Overlaps with Autumn 2026. Lessons of both terms will run in parallel.",
      ),
    ).toBeVisible();
    await dialog.getByLabel("First day").fill(`${year}-02-10`);
    await dialog.getByLabel("Last day").fill(`${year}-02-01`);
    await dialog.getByRole("button", { name: "Create term" }).click();
    await expect(
      dialog.getByText("The last day must be on or after the first day."),
    ).toBeVisible();
    await dialog.getByLabel("Last day").fill(`${year}-06-30`);
    // Blur first: clearing the error resizes the dialog under the pointer.
    await dialog.getByLabel("Last day").blur();
    await dialog.getByRole("button", { name: "Create term" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`${term} created`)).toBeVisible();
    // The term holiday row mentions the term too ("Applies to").
    const row = page.getByRole("row", { name: new RegExp(`^${term} \\d`) });
    await expect(row).toContainText("Draft");

    // Edit the dates.
    await openMenu(page, term, "Edit");
    const edit = page.getByRole("dialog", { name: "Edit term" });
    await edit.getByLabel("Last day").fill(`${year}-07-15`);
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(edit).toBeHidden();
    await expect(page.getByText("Changes saved")).toBeVisible();
    await expect(row).toContainText(`15 Jul ${year}`);

    // A holiday of this term only.
    const newHoliday = page.getByRole("dialog", { name: "New holiday" });
    await page.getByRole("button", { name: "Add holiday" }).click();
    await newHoliday.getByLabel("Name").fill(termHoliday);
    await newHoliday.getByLabel("First day").fill(`${year}-04-01`);
    await newHoliday.getByLabel("Last day").fill(`${year}-04-05`);
    await newHoliday.getByLabel("Only one term").check();
    await newHoliday.getByRole("button", { name: "Add holiday" }).click();
    await expect(newHoliday.getByText("Choose term.")).toBeVisible();
    await newHoliday
      .getByLabel("Term", { exact: true })
      .selectOption({ label: `Only ${term}` });
    await newHoliday.getByLabel("Term", { exact: true }).blur();
    await newHoliday.getByRole("button", { name: "Add holiday" }).click();
    await expect(newHoliday).toBeHidden();
    await expect(page.getByText(`${termHoliday} created`)).toBeVisible();

    // A school-wide holiday (no published term on that day).
    await page.getByRole("button", { name: "Add holiday" }).click();
    await newHoliday.getByLabel("Name").fill(schoolHoliday);
    await newHoliday.getByLabel("First day").fill(`${year}-05-01`);
    await newHoliday.getByLabel("Last day").fill(`${year}-05-01`);
    await expect(
      newHoliday.getByLabel("All terms (school-wide)"),
    ).toBeChecked();
    await newHoliday.getByRole("button", { name: "Add holiday" }).click();
    await expect(newHoliday).toBeHidden();
    await expect(page.getByText(`${schoolHoliday} created`)).toBeVisible();
    await expect(row).toContainText(/Draft\s*0\s*1/);

    // Scope filter.
    const filter = page.getByRole("combobox", { name: "Applies to" });
    await filter.selectOption({ label: term });
    await expect(
      page.getByRole("row", { name: new RegExp(termHoliday) }),
    ).toBeVisible();
    await expect(
      page.getByRole("row", { name: new RegExp(schoolHoliday) }),
    ).toHaveCount(0);
    await filter.selectOption("school");
    await expect(
      page.getByRole("row", { name: new RegExp(schoolHoliday) }),
    ).toContainText("All terms");
    await expect(
      page.getByRole("row", { name: new RegExp(termHoliday) }),
    ).toHaveCount(0);
    await filter.selectOption("");

    // Delete the term: its own holidays go with it, school-wide ones stay.
    await openMenu(page, term, /^Delete/);
    const remove = page.getByRole("alertdialog", { name: `Delete ${term}?` });
    await expect(remove).toContainText(
      "Its 0 slots and 1 term holiday are deleted too. School-wide holidays stay.",
    );
    await remove.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText(`${term} deleted`)).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(term) })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("row", { name: new RegExp(termHoliday) }),
    ).toHaveCount(0);

    await openMenu(page, schoolHoliday, "Delete");
    await page
      .getByRole("alertdialog", { name: `Delete ${schoolHoliday}?` })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(page.getByText(`${schoolHoliday} deleted`)).toBeVisible();
  });

  test("a published term can't be deleted", async ({ page }) => {
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto("/admin/settings/terms");
    await page.getByRole("button", { name: "Actions for Autumn 2026" }).click();
    await expect(
      page.getByRole("menuitem", { name: /^Delete/ }),
    ).toHaveAttribute("aria-disabled", "true");
  });
});

test.describe("admin › dashboard & school settings", () => {
  test("the setup checklist is hidden once the school is set up", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Set up your school")).toHaveCount(0);
  });

  test("school settings validate hours and days without saving", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto("/admin/settings");
    await expect(page).toHaveURL("/admin/settings/school");
    await expect(page.getByLabel("School name")).not.toHaveValue("");
    // Lessons exist, so the time zone is locked.
    await expect(page.getByLabel("Time zone")).toBeDisabled();
    await expect(
      page.getByText("The time zone can't change once lessons exist."),
    ).toBeVisible();
    await expect(page.getByLabel("Monday")).toBeChecked();
    await page.getByLabel("From", { exact: true }).fill("18:00");
    await page.getByLabel("To", { exact: true }).fill("09:00");
    for (const day of [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]) {
      await page.getByLabel(day).uncheck();
    }
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByText("The end time must be after the start time."),
    ).toBeVisible();
    await expect(
      page.getByText("Choose at least one school day."),
    ).toBeVisible();
  });
});
