import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  addDays,
  toZonedDateTime,
  zonedTimeToUtc,
} from "../src/server/scheduling/time";
import { DEMO_LOGINS, signIn, sql } from "./helpers";

// Happy path of CARM-66 (docs/design/notifications-substitutes.md §6, §7):
// a student rates their teacher, the admin sees the rating with the
// student's name and hides it, the teacher can't open the ratings; the
// student creates a calendar link, the feed serves their lessons and a
// reset turns the old link off. Runs in its own school whose term is
// half over today, so the rating window is open whatever the date.
test.describe("ratings and calendar subscription", () => {
  test.describe.configure({ mode: "serial" });
  const TZ = "Europe/Bratislava";
  const suffix = randomUUID().slice(0, 8);
  const today = toZonedDateTime(new Date(), TZ).date;
  const emails = {
    admin: `e2e-rate-a-${suffix}@demo-school.test`,
    teacher: `e2e-rate-t-${suffix}@demo-school.test`,
    student: `e2e-rate-s-${suffix}@demo-school.test`,
  };
  const teacherName = `Theo Teacher ${suffix}`;
  const studentName = `Stan Student ${suffix}`;
  const group = `E2E Rate ${suffix}`;
  const ids = {
    school: randomUUID(),
    term: randomUUID(),
    level: randomUUID(),
    group: randomUUID(),
    adminUser: randomUUID(),
    teacherUser: randomUUID(),
    teacher: randomUUID(),
    studentUser: randomUUID(),
    student: randomUUID(),
  };
  // Three ended lessons (rating needs 3) and one ahead, all 06:00–06:45.
  const lessonDates = [-14, -7, -3, 4].map((d) => addDays(today, d));
  const lessonIds = lessonDates.map(() => randomUUID());

  test.beforeAll(async () => {
    const [{ hash }] = await sql<{ hash: string }>(
      "SELECT password_hash AS hash FROM users WHERE email = $1",
      [DEMO_LOGINS.student],
    );
    await sql(
      `INSERT INTO schools (id, name, slug, timezone, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [ids.school, `E2E Ratings ${suffix}`, `e2e-ratings-${suffix}`, TZ],
    );
    await sql(
      `INSERT INTO users (id, email, name, password_hash, updated_at)
       VALUES ($1, $2, 'Ada Admin', $7, now()), ($3, $4, $8, $7, now()),
              ($5, $6, $9, $7, now())`,
      [
        ids.adminUser,
        emails.admin,
        ids.teacherUser,
        emails.teacher,
        ids.studentUser,
        emails.student,
        hash,
        teacherName,
        studentName,
      ],
    );
    await sql(
      `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ADMIN', now()),
              (gen_random_uuid(), $1, $3, 'TEACHER', now()),
              (gen_random_uuid(), $1, $4, 'STUDENT', now())`,
      [ids.school, ids.adminUser, ids.teacherUser, ids.studentUser],
    );
    await sql(
      `INSERT INTO levels (id, school_id, code, name, rank, updated_at)
       VALUES ($1, $2, 'B1', 'Intermediate', 1, now())`,
      [ids.level, ids.school],
    );
    await sql(
      `INSERT INTO teacher_profiles (id, school_id, user_id, updated_at)
       VALUES ($1, $2, $3, now())`,
      [ids.teacher, ids.school, ids.teacherUser],
    );
    await sql(
      `INSERT INTO student_profiles (id, school_id, user_id, level_id, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [ids.student, ids.school, ids.studentUser, ids.level],
    );
    // Half over today: rating opened at half-term, closes 14 days after.
    await sql(
      `INSERT INTO terms (id, school_id, name, start_date, end_date, timetable_published_at, updated_at)
       VALUES ($1, $2, 'E2E Term', $3, $4, now(), now())`,
      [ids.term, ids.school, addDays(today, -40), addDays(today, 30)],
    );
    await sql(
      `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at)
       VALUES ($1, $2, $3, 'GROUP', $4, 8, now())`,
      [ids.group, ids.school, ids.level, group],
    );
    await sql(
      `INSERT INTO group_memberships (id, school_id, group_id, student_id, joined_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
      [
        ids.school,
        ids.group,
        ids.student,
        zonedTimeToUtc(addDays(today, -40), 0, TZ),
      ],
    );
    for (const [i, date] of lessonDates.entries()) {
      const startsAt = zonedTimeToUtc(date, 6 * 60, TZ);
      await sql(
        `INSERT INTO lessons (id, school_id, term_id, group_id, teacher_id, starts_at, ends_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '45 minutes', now())`,
        [lessonIds[i], ids.school, ids.term, ids.group, ids.teacher, startsAt],
      );
    }
  });

  test.afterAll(async () => {
    await sql("DELETE FROM teacher_ratings WHERE school_id = $1", [ids.school]);
    await sql("DELETE FROM lessons WHERE school_id = $1", [ids.school]);
    await sql("DELETE FROM schools WHERE id = $1", [ids.school]);
    await sql("DELETE FROM users WHERE id = ANY($1)", [
      [ids.adminUser, ids.teacherUser, ids.studentUser],
    ]);
  });

  test("a student rates their teacher; only the admin sees it", async ({
    browser,
  }) => {
    const studentContext = await browser.newContext();
    const student = await studentContext.newPage();
    await signIn(student, emails.student);
    await student.waitForURL("/student");

    // Home card → rating form.
    await expect(
      student.getByText(`How are your lessons with ${teacherName}?`),
    ).toBeVisible();
    await student.getByRole("link", { name: "Rate now" }).click();
    await student.waitForURL(/\/student\/ratings\//);
    await expect(
      student.getByText(
        `Only the school's admins see this. ${teacherName} won't see it.`,
      ),
    ).toBeVisible();
    await student.getByRole("button", { name: "Submit rating" }).click();
    await expect(
      student.getByText("Choose a rating from 1 to 5 stars."),
    ).toBeVisible();
    // The radio is visually hidden behind its star.
    await student
      .getByRole("radio", { name: "Very good" })
      .check({ force: true });
    await expect(student.getByText("Very good", { exact: true })).toBeVisible();
    await student
      .getByLabel("Comment (optional)")
      .fill("Clear explanations, lots of speaking.");
    await student.getByRole("button", { name: "Submit rating" }).click();
    await expect(
      student.getByText("Thanks! Your rating is saved."),
    ).toBeVisible();
    await student.waitForURL("/student/ratings");
    await expect(
      student.getByRole("img", { name: "4 out of 5 stars" }),
    ).toBeVisible();
    await expect(student.getByText(/^You can change it until /)).toBeVisible();
    await studentContext.close();

    // The admin sees the rating with the student's name, then hides it.
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await signIn(admin, emails.admin);
    await admin.waitForURL("/admin");
    await admin.getByRole("link", { name: "Ratings", exact: true }).click();
    await admin.waitForURL("/admin/ratings");
    const row = admin.getByRole("row").filter({ hasText: teacherName });
    await expect(row).toContainText("Too few to average");
    await row.getByRole("link", { name: teacherName }).click();
    const list = admin.getByTestId("ratings-list");
    await expect(list).toContainText("Clear explanations, lots of speaking.");
    await expect(list).toContainText(studentName);
    await list.getByRole("button", { name: "Hide rating" }).click();
    await expect(admin.getByText("Rating hidden.")).toBeVisible();
    await expect(admin.getByText("Hidden ratings (1)")).toBeVisible();
    await adminContext.close();

    // The teacher has no way in.
    const teacherContext = await browser.newContext();
    const teacher = await teacherContext.newPage();
    await signIn(teacher, emails.teacher);
    await teacher.waitForURL("/teacher");
    await expect(
      teacher.getByRole("link", { name: "Ratings", exact: true }),
    ).toHaveCount(0);
    const forbidden = await teacher.goto("/admin/ratings");
    expect(forbidden?.status()).toBe(403);
    await teacherContext.close();
  });

  test("a student subscribes to their calendar and resets the link", async ({
    browser,
    request,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, emails.student);
    await page.waitForURL("/student");
    await page.goto("/student/calendar");
    await page.getByRole("button", { name: "Create my calendar link" }).click();
    const field = page.getByTestId("calendar-link");
    await expect(field).toHaveValue(/\/api\/calendar\/[A-Za-z0-9_-]{43}\.ics$/);
    const first = await field.inputValue();

    const feed = await request.get(first);
    expect(feed.status()).toBe(200);
    expect(feed.headers()["content-type"]).toContain("text/calendar");
    const text = await feed.text();
    expect(text).toContain("BEGIN:VCALENDAR");
    for (const id of lessonIds) {
      expect(text).toContain(`UID:lesson-${id}@schoolmanager`);
    }
    expect(text).toContain(`SUMMARY:${group}`);
    // Conditional request: unchanged → 304.
    const etag = feed.headers()["etag"];
    const again = await request.get(first, {
      headers: { "If-None-Match": etag },
    });
    expect(again.status()).toBe(304);

    await page.getByRole("button", { name: "Reset link…" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Reset link" })
      .click();
    await expect(page.getByText("Calendar link reset.")).toBeVisible();
    await expect(
      page.getByText("New link created. Add it to your calendar apps."),
    ).toBeVisible();
    await expect(field).not.toHaveValue(first);
    const second = await field.inputValue();

    const old = await request.get(first);
    expect(old.status()).toBe(404);
    expect(await old.text()).toBe("");
    expect((await request.get(second)).status()).toBe(200);
    await context.close();
  });
});
