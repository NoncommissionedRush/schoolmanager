import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  addDays,
  toZonedDateTime,
  zonedTimeToUtc,
} from "../src/server/scheduling/time";
import { mondayOf } from "../src/server/timetable/week";
import { currentTermId, DEMO_LOGINS, signIn, sql } from "./helpers";

// Happy path of CARM-65 notifications (docs/design/notifications-substitutes.md
// §4): a student cancels a lesson; their teacher sees the unread badge, opens
// the notification from the bell, lands on the lesson and the badge is gone;
// the inbox shows it read. Runs on its own teacher, group, student and lesson
// so other specs' notifications don't change the counts.
test.describe("notifications › bell, popover and inbox", () => {
  test.describe.configure({ mode: "serial" });
  const TZ = "Europe/Bratislava";
  const suffix = randomUUID().slice(0, 8);
  const group = `E2E Notify ${suffix}`;
  const teacherEmail = `e2e-notify-t-${suffix}@demo-school.test`;
  const studentEmail = `e2e-notify-s-${suffix}@demo-school.test`;
  const ids = {
    term: "",
    group: randomUUID(),
    teacherUser: randomUUID(),
    teacher: randomUUID(),
    studentUser: randomUUID(),
    student: randomUUID(),
    lesson: randomUUID(),
  };
  const today = toZonedDateTime(new Date(), TZ).date;
  const date = addDays(today, 3);
  const startsAt = zonedTimeToUtc(date, 10 * 60, TZ);

  test.beforeAll(async () => {
    const [row] = await sql<{ school: string; level: string; hash: string }>(
      `SELECT s.id AS school, g.level_id AS level, su.password_hash AS hash
       FROM schools s
       JOIN groups g ON g.school_id = s.id AND g.name = 'A2 Evening'
       JOIN users su ON su.email = $1
       WHERE s.slug = 'demo-language-school'`,
      [DEMO_LOGINS.student],
    );
    ids.term = await currentTermId(row.school, today, date);
    await sql(
      `INSERT INTO users (id, email, name, password_hash, updated_at)
       VALUES ($1, $2, 'Nora Notified', $3, now()), ($4, $5, 'Sam Student', $3, now())`,
      [ids.teacherUser, teacherEmail, row.hash, ids.studentUser, studentEmail],
    );
    await sql(
      `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'TEACHER', now()),
              (gen_random_uuid(), $1, $3, 'STUDENT', now())`,
      [row.school, ids.teacherUser, ids.studentUser],
    );
    await sql(
      `INSERT INTO teacher_profiles (id, school_id, user_id, updated_at)
       VALUES ($1, $2, $3, now())`,
      [ids.teacher, row.school, ids.teacherUser],
    );
    await sql(
      `INSERT INTO student_profiles (id, school_id, user_id, level_id, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [ids.student, row.school, ids.studentUser, row.level],
    );
    await sql(
      `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at)
       VALUES ($1, $2, $3, 'GROUP', $4, 8, now())`,
      [ids.group, row.school, row.level, group],
    );
    await sql(
      `INSERT INTO group_memberships (id, school_id, group_id, student_id, joined_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now() - interval '1 day', now())`,
      [row.school, ids.group, ids.student],
    );
    await sql(
      `INSERT INTO lessons (id, school_id, term_id, group_id, teacher_id, starts_at, ends_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '90 minutes', now())`,
      [ids.lesson, row.school, ids.term, ids.group, ids.teacher, startsAt],
    );
  });

  test.afterAll(async () => {
    await sql("DELETE FROM makeup_credits WHERE source_lesson_id = $1", [
      ids.lesson,
    ]);
    await sql("DELETE FROM absence_reports WHERE lesson_id = $1", [ids.lesson]);
    await sql("DELETE FROM lessons WHERE id = $1", [ids.lesson]);
    await sql("DELETE FROM group_memberships WHERE group_id = $1", [ids.group]);
    await sql("DELETE FROM groups WHERE id = $1", [ids.group]);
    await sql("DELETE FROM student_profiles WHERE id = $1", [ids.student]);
    await sql("DELETE FROM teacher_profiles WHERE id = $1", [ids.teacher]);
    const users = [ids.teacherUser, ids.studentUser];
    await sql("DELETE FROM memberships WHERE user_id = ANY($1)", [users]);
    // Notifications go with their recipient.
    await sql("DELETE FROM users WHERE id = ANY($1)", [users]);
  });

  test("the teacher is told a student won't come and opens the lesson from the bell", async ({
    browser,
  }) => {
    // The student cancels from their timetable.
    const studentContext = await browser.newContext();
    const student = await studentContext.newPage();
    await signIn(student, studentEmail);
    await student.waitForURL("/student");
    await student.goto(`/student/timetable?week=${mondayOf(date)}`);
    await student
      .getByRole("button", { name: new RegExp(`^${group}, \\w+ 10:00 to`) })
      .click();
    await student.getByRole("button", { name: "Can't attend?" }).click();
    await student
      .getByRole("dialog", { name: `Cancel ${group}?` })
      .getByRole("button", { name: "Cancel my lesson" })
      .click();
    await expect(student.getByText(/^Lesson cancelled\./)).toBeVisible();
    // Nobody is told about their own action.
    await student.keyboard.press("Escape");
    await expect(
      student.getByRole("button", { name: "Notifications", exact: true }),
    ).toBeVisible();
    await studentContext.close();

    const teacherContext = await browser.newContext();
    const page = await teacherContext.newPage();
    await signIn(page, teacherEmail);
    await page.waitForURL("/teacher");
    const bell = page.getByRole("button", { name: "Notifications, 1 unread" });
    await expect(bell).toBeVisible();
    await expect(page.getByTestId("notification-badge")).toHaveText("1");

    await bell.click();
    const popover = page.getByRole("dialog");
    await expect(
      popover.getByRole("heading", { name: "Notifications" }),
    ).toBeVisible();
    const item = popover.getByRole("link", {
      name: new RegExp(`Unread: Sam Student won't be at ${group} on`),
    });
    await expect(item).toBeVisible();
    await expect(item).toContainText("ago");
    await item.click();

    // Marked read on the server before navigating: the badge is gone.
    await page.waitForURL(`/teacher/lessons/${ids.lesson}`);
    await expect(
      page.getByRole("button", { name: "Notifications", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("notification-badge")).toBeHidden();

    // The inbox lists it as read, under its day.
    await page.goto("/teacher/notifications");
    await expect(
      page.getByRole("heading", { level: 1, name: "Notifications" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
    const entry = page.getByTestId("notification").filter({ hasText: group });
    await expect(entry).toHaveAttribute("data-read", "true");
    await expect(entry).toContainText("Open lesson");
    await expect(
      page.getByText("Notifications older than 90 days are removed."),
    ).toBeVisible();
    await page.getByRole("link", { name: "Unread (0)" }).click();
    await expect(page.getByText("You're all caught up.")).toBeVisible();
    await teacherContext.close();
  });
});
