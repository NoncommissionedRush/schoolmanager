import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { seedDate } from "../clock";
import { DEMO_LOGINS, signIn } from "../helpers";

test.describe("admin › teachers", () => {
  test("create a teacher, edit availability, archive", async ({ page }) => {
    const stamp = randomUUID().slice(0, 8);
    const name = `E2E Teacher ${stamp}`;
    const email = `e2e.teacher.${stamp}@Example.test`;
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto("/admin/teachers");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Teachers",
    );

    // Create: generated password → credentials shown once.
    await page.getByRole("button", { name: "New teacher" }).click();
    const dialog = page.getByRole("dialog", { name: "New teacher" });
    await dialog.getByLabel("Full name").fill(name);
    await dialog.getByLabel("Email").fill(email);
    await dialog.getByRole("button", { name: "Create teacher" }).click();
    await expect(dialog.getByText("Use at least 10 characters.")).toBeVisible();
    await dialog.getByRole("button", { name: "Generate" }).click();
    await dialog.getByText("Teal").click();
    await dialog.getByRole("button", { name: "Create teacher" }).click();
    const credentials = page.getByRole("dialog", {
      name: "Share these sign-in details",
    });
    await expect(credentials.getByTestId("credentials")).toContainText(
      email.toLowerCase(),
    );
    await credentials.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText(`${name} created`)).toBeVisible();

    // Duplicate email (any case) is rejected.
    await page.getByRole("button", { name: "New teacher" }).click();
    await dialog.getByLabel("Full name").fill(`${name} 2`);
    await dialog.getByLabel("Email").fill(email.toUpperCase());
    await dialog.getByRole("button", { name: "Generate" }).click();
    await dialog.getByRole("button", { name: "Create teacher" }).click();
    await expect(
      dialog.getByText("This email is already used by another account."),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // Open the detail from the list.
    await page
      .getByRole("searchbox", { name: "Search by name or email" })
      .fill(name);
    await expect(page.getByRole("row")).toHaveCount(2);
    await page.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    await expect(page.getByLabel("Teal")).toBeChecked();

    // Profile: save a bio.
    await page.getByLabel("Bio").fill("Teaches English and German.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Changes saved")).toBeVisible();

    // Availability tab is URL-addressable.
    await page.getByRole("tab", { name: "Availability" }).click();
    await expect(page).toHaveURL(/\?tab=availability/);
    await expect(
      page.getByText("E2E is available during all school hours."),
    ).toBeVisible();

    // Weekly unavailability; an overlapping time on the same day merges.
    await page.getByRole("button", { name: "Add unavailable time" }).click();
    const weekly = page.getByRole("dialog", { name: "Add unavailable time" });
    await weekly.getByLabel("Mon", { exact: true }).check();
    await weekly.getByLabel("Wed", { exact: true }).check();
    await weekly.getByLabel("From").fill("07:00");
    await weekly.getByLabel("To").fill("06:00");
    await weekly.getByRole("button", { name: "Save" }).click();
    await expect(
      weekly.getByText("The end time must be after the start time."),
    ).toBeVisible();
    await weekly.getByLabel("To").fill("09:00");
    // Blur first: the error line goes away and the dialog shrinks.
    await weekly.getByLabel("To").blur();
    await weekly.getByRole("button", { name: "Save" }).click();
    await expect(weekly).toBeHidden();
    await expect(page.getByText("Every Monday · 07:00–09:00")).toBeVisible();
    await expect(page.getByText("Every Wednesday · 07:00–09:00")).toBeVisible();

    await page.getByRole("button", { name: "Add unavailable time" }).click();
    await weekly.getByLabel("Mon", { exact: true }).check();
    await weekly.getByLabel("From").fill("08:30");
    await weekly.getByLabel("To").fill("12:00");
    await weekly.getByRole("button", { name: "Save" }).click();
    await expect(
      page.getByText("Merged with an existing time on Monday."),
    ).toBeVisible();
    await expect(page.getByText("Every Monday · 07:00–12:00")).toBeVisible();
    await expect(page.getByText("Every Monday · 07:00–09:00")).toHaveCount(0);

    await page
      .getByRole("button", { name: "Delete Wednesday 07:00–09:00" })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(page.getByText("Every Wednesday · 07:00–09:00")).toHaveCount(
      0,
    );

    // Exceptions: range limit, "no effect" warning, then a whole-day one.
    await page.getByRole("button", { name: "Add exception" }).click();
    const exception = page.getByRole("dialog", { name: "Add exception" });
    await exception
      .getByLabel("Date", { exact: true })
      .fill(seedDate("2026-12-01"));
    await exception.getByLabel("To date").fill(seedDate("2027-01-15"));
    await exception.getByRole("button", { name: "Save" }).click();
    await expect(
      exception.getByText(
        "Choose 31 days or fewer. Add longer absences in parts.",
      ),
    ).toBeVisible();
    await exception.getByLabel("To date").fill(seedDate("2026-12-02"));
    await exception.getByLabel("To date").blur();
    // 1–2 Dec 2026 are a Tuesday and a Wednesday: no weekly rule left.
    await exception
      .getByLabel("Available on this date (overrides the weekly rule)")
      .check();
    await expect(
      exception.getByText(
        "There's no weekly unavailability on this day, so this exception has no effect.",
      ),
    ).toBeVisible();
    await exception
      .getByLabel("Unavailable on this date", { exact: true })
      .check();
    await exception.getByLabel("Note").fill("Conference");
    await exception.getByRole("button", { name: "Save" }).click();
    await expect(exception).toBeHidden();
    const rows = page.getByRole("row", { name: /Conference/ });
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Unavailable");
    await expect(rows.first()).toContainText("Whole day");

    // A new teacher without slots can be archived (and restored).
    await page
      .getByRole("button", { name: `More actions for ${name}` })
      .click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await page
      .getByRole("alertdialog", { name: `Archive ${name}?` })
      .getByRole("button", { name: "Archive" })
      .click();
    await expect(page.getByText(`${name} archived`)).toBeVisible();
    await expect(
      page.locator('[data-slot="badge"]', { hasText: /^Archived$/ }),
    ).toBeVisible();
  });

  test("archiving a teacher with timetable slots is blocked", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto("/admin/teachers?q=Jana");
    await page
      .getByRole("button", { name: "Actions for Jana Nováková" })
      .click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await page
      .getByRole("alertdialog", { name: "Archive Jana Nováková?" })
      .getByRole("button", { name: "Archive" })
      .click();
    const blocked = page.getByRole("alertdialog", {
      name: "Jana Nováková can't be archived yet",
    });
    await expect(blocked).toContainText(/still teaches \d+ timetable slots/);
    await expect(
      blocked.getByRole("link", { name: "Open timetable" }),
    ).toBeVisible();
    await blocked.getByRole("button", { name: "OK" }).click();
    await expect(blocked).toBeHidden();
  });

  test("groups tab lists the teacher's slots in the current term", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto("/admin/teachers?q=Jana");
    await page.getByRole("link", { name: "Jana Nováková" }).click();
    await page.getByRole("tab", { name: "Groups" }).click();
    await expect(page).toHaveURL(/\?tab=groups/);
    await expect(page.getByLabel("Term")).toHaveValue(/.+/);
    await expect(
      page.getByRole("table", { name: /Groups of Jana Nováková/ }),
    ).toBeVisible();
  });

  test("an unknown or malformed teacher id shows not found", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    // The page streams inside the admin loading boundary, so the status is
    // already sent; check the rendered not-found page instead.
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      await page.goto(`/admin/teachers/${id}`);
      await expect(
        page.getByRole("heading", { name: "Page not found" }),
      ).toBeVisible();
    }
  });
});
