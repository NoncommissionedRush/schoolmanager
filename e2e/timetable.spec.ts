import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { DEMO_LOGINS, signIn, sql } from "./helpers";

// Happy path of the timetable editor (CARM-25): create a slot, hit a
// conflict, override a warning, publish, and see the lesson as the teacher
// and as a student of the group. Runs in its own draft term in March 2027,
// far from the seeded Autumn 2026 term.
const TERM_START = "2027-03-01"; // Monday
const TERM_END = "2027-03-28";

async function removeTerm(name: string) {
  const terms = await sql<{ id: string }>(
    "SELECT id FROM terms WHERE name = $1",
    [name],
  );
  for (const { id } of terms) {
    await sql("DELETE FROM lessons WHERE term_id = $1", [id]);
    await sql("DELETE FROM timetable_slots WHERE term_id = $1", [id]);
    await sql("DELETE FROM terms WHERE id = $1", [id]);
  }
}

test.describe("timetable editor › create, override, publish", () => {
  const termName = `E2E Timetable ${Date.now()}`;
  let termId: string;
  let groupId: string;
  let teacherId: string;

  test.beforeAll(async () => {
    const [school] = await sql<{ id: string }>(
      "SELECT id FROM schools WHERE slug = 'demo-language-school'",
    );
    const [group] = await sql<{ id: string }>(
      "SELECT id FROM groups WHERE name = 'A1 Morning' AND school_id = $1",
      [school.id],
    );
    const [other] = await sql<{ id: string }>(
      "SELECT id FROM groups WHERE name = 'A2 Evening' AND school_id = $1",
      [school.id],
    );
    const [teacher] = await sql<{ id: string }>(
      `SELECT tp.id FROM teacher_profiles tp JOIN users u ON u.id = tp.user_id
       WHERE u.email = $1 AND tp.school_id = $2`,
      [DEMO_LOGINS.teacher, school.id],
    );
    groupId = group.id;
    teacherId = teacher.id;
    termId = randomUUID();
    await sql(
      `INSERT INTO terms (id, school_id, name, start_date, end_date, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [termId, school.id, termName, TERM_START, TERM_END],
    );
    // Jana already teaches A2 Evening on Mondays 10:00–11:00 in this term.
    await sql(
      `INSERT INTO timetable_slots
         (id, school_id, term_id, group_id, teacher_id, weekday, start_minute, end_minute, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, 600, 660, now())`,
      [randomUUID(), school.id, termId, other.id, teacher.id],
    );
  });

  test.afterAll(async () => {
    await removeTerm(termName);
  });

  test("admin builds and publishes; teacher and student see the lesson", async ({
    browser,
  }) => {
    const admin = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await signIn(admin, DEMO_LOGINS.admin);
    await admin.waitForURL("/admin");
    await admin.goto(`/admin/timetable/edit?term=${termId}&day=1`);
    await expect(
      admin.getByRole("heading", { level: 1, name: "Timetable editor" }),
    ).toBeVisible();
    await expect(admin.getByText("Draft", { exact: true })).toBeVisible();

    // New slot that clashes with Jana's A2 Evening lesson: blocking.
    await admin.getByRole("button", { name: "New slot" }).click();
    const sheet = admin.getByRole("dialog", { name: "New slot" });
    await sheet.getByLabel("Group").selectOption(groupId);
    await sheet.getByLabel("Teacher").selectOption(teacherId);
    await sheet.getByLabel("Day").selectOption("1");
    await sheet.getByLabel("Start").selectOption("600");
    await expect(sheet.getByLabel("End")).toHaveValue("660");
    await expect(
      sheet.getByText(/Jana Nováková is already teaching A2 Evening/),
    ).toBeVisible();
    await expect(sheet.getByText("Conflict", { exact: true })).toBeVisible();
    await sheet.getByRole("button", { name: "Save slot" }).click();
    await expect(
      sheet.getByRole("heading", { name: "Fix the conflicts before saving." }),
    ).toBeVisible();

    // Move it to 06:00: no clash, but outside school hours (a warning).
    await sheet.getByLabel("Start").selectOption("360");
    await expect(
      sheet.getByText(/06:00–07:00 is outside school hours/),
    ).toBeVisible();
    await expect(sheet.getByText(/already teaching/)).toBeHidden();
    await sheet.getByRole("button", { name: "Save slot" }).click();
    await expect(
      sheet.getByText("Tick each warning to save anyway."),
    ).toBeVisible();
    const checkboxes = sheet.getByRole("checkbox", {
      name: /I've checked this/,
    });
    for (const box of await checkboxes.all()) await box.click();
    await sheet.getByLabel("Reason (optional)").fill("Early class agreed");
    await sheet.getByRole("button", { name: "Save anyway" }).click();
    await expect(sheet).toBeHidden();
    await expect(admin.getByText("Slot saved")).toBeVisible();

    // The override is in the audit log.
    const [entry] = await sql<{
      data: { overridden: { type: string }[]; reason: string };
    }>(
      `SELECT a.data FROM audit_logs a JOIN timetable_slots s ON s.id = a.entity_id
       WHERE s.term_id = $1 AND a.action = 'timetable_slot.created'`,
      [termId],
    );
    expect(entry.data.overridden.map((c) => c.type)).toContain(
      "OUTSIDE_SCHOOL_HOURS",
    );
    expect(entry.data.reason).toBe("Early class agreed");

    // The new block is in the grid with an acknowledged warning.
    await expect(
      admin.getByRole("button", {
        name: /^A1 Morning, Monday 06:00–07:00, Jana Nováková/,
      }),
    ).toBeVisible();

    // Publish.
    await admin.getByRole("button", { name: "Publish", exact: true }).click();
    const publish = admin.getByRole("dialog", { name: `Publish ${termName}?` });
    await expect(publish.getByText("2 slots")).toBeVisible();
    await publish.getByRole("button", { name: "Publish timetable" }).click();
    await expect(publish).toBeHidden();
    await expect(
      admin.getByText(
        new RegExp(`${termName} published\\. \\d+ lessons created\\.`),
      ),
    ).toBeVisible();
    await expect(admin.getByText(/^Published /)).toBeVisible();
    await admin.close();

    // Teacher sees the lesson in their week.
    const teacher = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await signIn(teacher, DEMO_LOGINS.teacher);
    await teacher.waitForURL("/teacher");
    await teacher.getByRole("link", { name: "My timetable" }).click();
    await expect(
      teacher.getByRole("heading", { level: 1, name: "My timetable" }),
    ).toBeVisible();
    await teacher.goto(`/teacher/timetable?week=${TERM_START}`);
    const lesson = teacher.getByRole("button", {
      name: /^A1 Morning, Monday 06:00 to 07:00/,
    });
    await expect(lesson).toBeVisible();
    await lesson.click();
    const details = teacher.getByRole("dialog", { name: "A1 Morning" });
    await expect(details.getByText(/Monday,? 1 March 2027/)).toBeVisible();
    await expect(details.getByText(/Students \(\d+\)/)).toBeVisible();
    await teacher.close();

    // A student of the group sees it too, without classmates' names.
    const student = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await signIn(student, DEMO_LOGINS.student);
    await student.waitForURL("/student");
    await student.goto(`/student/timetable?week=${TERM_START}`);
    const card = student.getByRole("button", {
      name: /^A1 Morning, Monday 06:00 to 07:00/,
    });
    await expect(card).toBeVisible();
    await card.click();
    const studentDetails = student.getByRole("dialog", { name: "A1 Morning" });
    await expect(studentDetails.getByText("Jana Nováková")).toBeVisible();
    await expect(studentDetails.getByText(/Students \(/)).toBeHidden();
    await student.close();
  });
});
