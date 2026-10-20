import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  addDays,
  toZonedDateTime,
  zonedTimeToUtc,
} from "../src/server/scheduling/time";
import { mondayOf } from "../src/server/timetable/week";
import { currentTime } from "./clock";
import { currentTermId, DEMO_LOGINS, signIn, sql } from "./helpers";

// Happy path of CARM-42 (absences.md §5): a student cancels an upcoming
// lesson in time and gets a makeup credit, cancels a lesson that starts
// soon without one, and sees both on the Absences tab; the teacher sees
// who isn't coming on the lesson page. Runs on its own group, student and
// lessons (in the term running today) so it doesn't depend on (or change)
// the seeded data.
test.describe("absences › student cancels and gets a makeup credit", () => {
  test.describe.configure({ mode: "serial" });
  const TZ = "Europe/Bratislava";
  const suffix = randomUUID().slice(0, 8);
  const group = `E2E Absence ${suffix}`;
  const studentEmail = `e2e-absence-${suffix}@demo-school.test`;
  // Unique: the admin picks the student by name from the whole school.
  const student = `Alena Absent ${suffix}`;
  const ids = {
    term: "", // the current term (beforeAll)
    group: randomUUID(),
    user: randomUUID(),
    student: randomUUID(),
    early: randomUUID(), // in three days, 10:00: earns a credit
    late: randomUUID(), // in two hours: after the 24-hour cutoff
  };
  const now = currentTime();
  const today = toZonedDateTime(now, TZ).date;
  const earlyDate = addDays(today, 3);
  const earlyStart = zonedTimeToUtc(earlyDate, 10 * 60, TZ);
  const lateStart = new Date(
    Math.ceil((now.getTime() + 2 * 3_600_000) / 900_000) * 900_000,
  );
  const lateLocal = toZonedDateTime(lateStart, TZ);
  const lateDate = lateLocal.date;
  const hhmm = (minute: number) =>
    `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  /** A lesson block: "{group}, {weekday} {start} to {end}…". */
  const block = (start: string) => new RegExp(`^${group}, \\w+ ${start} to`);
  const REASON = `Doctor's appointment ${suffix}`;

  test.beforeAll(async () => {
    const [row] = await sql<{
      school: string;
      level: string;
      teacher: string;
      hash: string;
    }>(
      `SELECT s.id AS school, g.level_id AS level, tp.id AS teacher, su.password_hash AS hash
       FROM schools s
       JOIN groups g ON g.school_id = s.id AND g.name = 'A2 Evening'
       JOIN teacher_profiles tp ON tp.school_id = s.id
       JOIN users u ON u.id = tp.user_id AND u.email = $1
       JOIN users su ON su.email = $2
       WHERE s.slug = 'demo-language-school'`,
      [DEMO_LOGINS.teacher, DEMO_LOGINS.student],
    );
    // Terms never overlap: the lessons go into the term running today.
    ids.term = await currentTermId(row.school, today, earlyDate);
    await sql(
      `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at)
       VALUES ($1, $2, $3, 'GROUP', $4, 8, now())`,
      [ids.group, row.school, row.level, group],
    );
    await sql(
      `INSERT INTO users (id, email, name, password_hash, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [ids.user, studentEmail, student, row.hash],
    );
    await sql(
      `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'STUDENT', now())`,
      [row.school, ids.user],
    );
    await sql(
      `INSERT INTO student_profiles (id, school_id, user_id, level_id, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [ids.student, row.school, ids.user, row.level],
    );
    await sql(
      `INSERT INTO group_memberships (id, school_id, group_id, student_id, joined_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now() - interval '1 day', now())`,
      [row.school, ids.group, ids.student],
    );
    await sql(
      `INSERT INTO lessons (id, school_id, term_id, group_id, teacher_id, starts_at, ends_at, updated_at)
       VALUES ($1, $3, $4, $5, $6, $7, $7::timestamptz + interval '90 minutes', now()),
              ($2, $3, $4, $5, $6, $8, $8::timestamptz + interval '45 minutes', now())`,
      [
        ids.early,
        ids.late,
        row.school,
        ids.term,
        ids.group,
        row.teacher,
        earlyStart,
        lateStart,
      ],
    );
  });

  test.afterAll(async () => {
    const lessons = [ids.early, ids.late];
    await sql("DELETE FROM makeup_credits WHERE source_lesson_id = ANY($1)", [
      lessons,
    ]);
    await sql("DELETE FROM absence_reports WHERE lesson_id = ANY($1)", [
      lessons,
    ]);
    await sql("DELETE FROM lessons WHERE id = ANY($1)", [lessons]);
    await sql("DELETE FROM group_memberships WHERE group_id = $1", [ids.group]);
    await sql("DELETE FROM student_profiles WHERE id = $1", [ids.student]);
    await sql("DELETE FROM memberships WHERE user_id = $1", [ids.user]);
    await sql("DELETE FROM users WHERE id = $1", [ids.user]);
    await sql("DELETE FROM groups WHERE id = $1", [ids.group]);
  });

  test("the student cancels in time, gets a credit, and the teacher sees it", async ({
    browser,
  }) => {
    const studentContext = await browser.newContext();
    const page = await studentContext.newPage();
    await signIn(page, studentEmail);
    await page.waitForURL("/student");

    // Before the cutoff: the dialog promises a credit.
    await page.goto(`/student/timetable?week=${mondayOf(earlyDate)}`);
    await page.getByRole("button", { name: block("10:00") }).click();
    const sheet = page.getByRole("dialog", { name: group });
    await expect(
      sheet.getByText(/^Cancel by .* to get a makeup credit\.$/),
    ).toBeVisible();
    await sheet.getByRole("button", { name: "Can't attend?" }).click();
    const dialog = page.getByRole("dialog", { name: `Cancel ${group}?` });
    await expect(
      dialog.getByText(/^You'll get a makeup credit, valid until /),
    ).toBeVisible();
    await dialog.getByLabel("Reason (optional)").fill(REASON);
    await dialog.getByRole("button", { name: "Cancel my lesson" }).click();
    await expect(
      page.getByText(/^Lesson cancelled\. You have a makeup credit until /),
    ).toBeVisible();

    // The lesson now reads "Not attending"; it can't be cancelled twice.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: block("10:00") }).click();
    await expect(sheet.getByText("You got a makeup credit.")).toBeVisible();
    await expect(
      sheet.getByRole("button", { name: "Can't attend?" }),
    ).toBeHidden();
    await page.keyboard.press("Escape");

    // After the cutoff: no credit.
    await page.goto(`/student/timetable?week=${mondayOf(lateDate)}`);
    const lateCard = page.getByRole("button", {
      name: block(hhmm(lateLocal.minute)),
    });
    await lateCard.click();
    await page.getByRole("button", { name: "Can't attend?" }).click();
    const lateDialog = page.getByRole("dialog", { name: `Cancel ${group}?` });
    await expect(
      lateDialog.getByText(/so you won't get a makeup credit/),
    ).toBeVisible();
    await lateDialog
      .getByRole("button", { name: "Cancel without credit" })
      .click();
    await expect(
      page.getByText(
        "Lesson cancelled. No credit, because it was after the cutoff.",
      ),
    ).toBeVisible();

    // The Absences tab: one credit, two upcoming cancellations.
    await page.goto("/student/absences");
    await expect(
      page.getByRole("heading", { level: 1, name: "Absences & credits" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Cancel at least 24 hours before a lesson to get a makeup credit. Credits are valid for 30 days.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Makeup credits (1)" }),
    ).toBeVisible();
    await expect(page.getByText(/^Valid until /)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Upcoming cancellations (2)" }),
    ).toBeVisible();
    await expect(page.getByText("Credit earned")).toBeVisible();
    await expect(page.getByText("No credit", { exact: true })).toBeVisible();
    await studentContext.close();

    // The teacher sees who isn't coming, with the reason.
    const teacherContext = await browser.newContext();
    const teacher = await teacherContext.newPage();
    await signIn(teacher, DEMO_LOGINS.teacher);
    await teacher.waitForURL("/teacher");
    await teacher.goto(`/teacher/lessons/${ids.early}`);
    await expect(teacher.getByText("Not coming (1)")).toBeVisible();
    const row = teacher.getByRole("listitem").filter({ hasText: REASON });
    await expect(row).toContainText(student);
    await expect(row).toContainText("cancelled");
    await teacherContext.close();
  });

  test("the admin sees the cancellations, deletes one and reports it again", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await page.goto(`/admin/absences?student=${ids.student}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Absences & replacements" }),
    ).toBeVisible();
    const rows = page.getByRole("row").filter({ hasText: student });
    await expect(rows).toHaveCount(2);
    const late = rows.filter({ hasText: "Late — no credit" });
    await late.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Delete absence…" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete absence" })
      .click();
    await expect(page.getByText("Absence deleted.")).toBeVisible();
    await expect(rows).toHaveCount(1);

    // The office reports it again: still after the cutoff, so no credit.
    await page.getByRole("button", { name: "Report absence" }).click();
    const dialog = page.getByRole("dialog", { name: "Report an absence" });
    await dialog.getByLabel("Student").selectOption({ label: student });
    const lesson = dialog.getByLabel("Lesson");
    await expect(lesson.locator("option")).toHaveCount(3);
    await lesson.selectOption({ index: 1 });
    await expect(
      dialog.getByText(
        `It's after the cutoff, so ${student} won't get a makeup credit.`,
      ),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Report absence" }).click();
    await expect(
      page.getByText(`Absence reported for ${student}.`),
    ).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "By " })).toHaveCount(1);

    // Settings › Absences & credits shows the current values with examples.
    await page.goto("/admin/settings/absences");
    await expect(
      page.getByLabel("Cancellation cutoff, in hours before the lesson"),
    ).toHaveValue("24");
    await expect(page.getByText(/^Example: for a lesson on /)).toBeVisible();
  });
});
