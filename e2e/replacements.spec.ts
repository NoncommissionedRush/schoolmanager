import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { addDays, zonedTimeToUtc } from "../src/server/scheduling/time";
import { mondayOf } from "../src/server/timetable/week";
import { currentTime, TODAY } from "./clock";
import { currentTermId, DEMO_LOGINS, signIn, sql } from "./helpers";
import { callAction, serverActionsIn } from "./server-actions";

// Happy path of CARM-43 (absences.md §4.1, §6.1, §7.3): a student cancels
// a lesson in time, books a replacement in another group of their level
// with the credit, the teacher sees them on that lesson, and an admin
// overrides the booking onto another lesson. Runs on its own groups, room,
// student and lessons (in the term running today) so it doesn't depend on
// the seeded data.
test.describe("replacements › cancel, book, teacher sees, admin overrides", () => {
  test.describe.configure({ mode: "serial" });
  const TZ = "Europe/Bratislava";
  const suffix = randomUUID().slice(0, 8);
  const own = `E2E Own ${suffix}`;
  const other = `E2E Other ${suffix}`;
  const studentEmail = `e2e-replacement-${suffix}@demo-school.test`;
  const STUDENT = `Rita Replacement ${suffix}`;
  const ids = {
    term: "", // the current term (beforeAll)
    own: randomUUID(),
    other: randomUUID(),
    room: randomUUID(),
    user: randomUUID(),
    student: randomUUID(),
    missed: randomUUID(), // own group, in three days 10:00
    target: randomUUID(), // other group, in four days 14:00
    moved: randomUUID(), // other group, in five days 14:00
  };
  const today = TODAY;
  const missedDate = addDays(today, 3);
  const targetDate = addDays(today, 4);
  const movedDate = addDays(today, 5);
  const block = (group: string, start: string) =>
    new RegExp(`^${group}, \\w+ ${start} to`);

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
    ids.term = await currentTermId(row.school, today, movedDate);
    await sql(
      `INSERT INTO rooms (id, school_id, name, kind, capacity, updated_at)
       VALUES ($1, $2, $3, 'PHYSICAL', 5, now())`,
      [ids.room, row.school, `E2E Room ${suffix}`],
    );
    await sql(
      `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at)
       VALUES ($1, $3, $4, 'GROUP', $5, 8, now()), ($2, $3, $4, 'GROUP', $6, 8, now())`,
      [ids.own, ids.other, row.school, row.level, own, other],
    );
    await sql(
      `INSERT INTO users (id, email, name, password_hash, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [ids.user, studentEmail, STUDENT, row.hash],
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
      [row.school, ids.own, ids.student],
    );
    const lesson = (id: string, group: string, startsAt: Date) => [
      id,
      row.school,
      ids.term,
      group,
      row.teacher,
      ids.room,
      startsAt,
    ];
    for (const values of [
      lesson(ids.missed, ids.own, zonedTimeToUtc(missedDate, 10 * 60, TZ)),
      lesson(ids.target, ids.other, zonedTimeToUtc(targetDate, 14 * 60, TZ)),
      lesson(ids.moved, ids.other, zonedTimeToUtc(movedDate, 14 * 60, TZ)),
    ]) {
      await sql(
        `INSERT INTO lessons (id, school_id, term_id, group_id, teacher_id, room_id, starts_at, ends_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7::timestamptz + interval '90 minutes', now())`,
        values,
      );
    }
  });

  test.afterAll(async () => {
    const lessons = [ids.missed, ids.target, ids.moved];
    await sql("DELETE FROM replacement_requests WHERE student_id = $1", [
      ids.student,
    ]);
    await sql("DELETE FROM makeup_credits WHERE student_id = $1", [
      ids.student,
    ]);
    await sql("DELETE FROM absence_reports WHERE student_id = $1", [
      ids.student,
    ]);
    await sql("DELETE FROM lessons WHERE id = ANY($1)", [lessons]);
    await sql("DELETE FROM group_memberships WHERE student_id = $1", [
      ids.student,
    ]);
    await sql("DELETE FROM student_profiles WHERE id = $1", [ids.student]);
    await sql("DELETE FROM memberships WHERE user_id = $1", [ids.user]);
    await sql("DELETE FROM users WHERE id = $1", [ids.user]);
    await sql("DELETE FROM groups WHERE id = ANY($1)", [[ids.own, ids.other]]);
    await sql("DELETE FROM rooms WHERE id = $1", [ids.room]);
  });

  test("the student cancels, gets a credit and books a replacement", async ({
    page,
  }) => {
    await signIn(page, studentEmail);
    await page.waitForURL("/student");

    // Cancel in time: a makeup credit.
    await page.goto(`/student/timetable?week=${mondayOf(missedDate)}`);
    await page.getByRole("button", { name: block(own, "10:00") }).click();
    await page.getByRole("button", { name: "Can't attend?" }).click();
    await page
      .getByRole("dialog", { name: `Cancel ${own}?` })
      .getByRole("button", { name: "Cancel my lesson" })
      .click();
    await expect(
      page.getByText(/^Lesson cancelled\. You have a makeup credit until /),
    ).toBeVisible();

    // Book a replacement with it.
    await page.goto("/student/absences");
    await page.getByRole("link", { name: "Book a replacement" }).click();
    await page.waitForURL(/\/student\/absences\/book\?credit=/);
    await page.goto(`${page.url()}&week=${mondayOf(targetDate)}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Book a replacement" }),
    ).toBeVisible();
    // Only lessons of the student's level with free seats; seats counted.
    const card = page.getByRole("listitem").filter({ hasText: other }).first();
    await expect(card).toContainText("5 seats left");
    await expect(page.getByText(own, { exact: true })).toBeHidden();
    await card.getByRole("button", { name: /^Book / }).click();
    const confirm = page.getByRole("dialog", { name: /^Book .*\?$/ });
    await expect(
      confirm.getByText(/^This uses your makeup credit from /),
    ).toBeVisible();
    await confirm.getByRole("button", { name: "Book", exact: true }).click();
    await page.waitForURL("/student/absences");
    await expect(page.getByText(/^Replacement booked for /)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Upcoming bookings (1)" }),
    ).toBeVisible();
    await expect(
      page.getByText("For your lesson on", { exact: false }),
    ).toBeVisible();

    // It shows in the timetable as a replacement.
    await page.goto(`/student/timetable?week=${mondayOf(targetDate)}`);
    await page
      .getByRole("button", { name: block(other, "14:00") })
      .first()
      .click();
    await expect(
      page.getByText(/^Replacement for your lesson on /),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel booking" }),
    ).toBeVisible();
  });

  test("the teacher sees the replacement student on the lesson page", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.teacher);
    await page.waitForURL("/teacher");
    await page.goto(`/teacher/lessons/${ids.target}`);
    await expect(page.getByText("Coming (1)")).toBeVisible();
    const row = page.getByRole("listitem").filter({ hasText: STUDENT });
    await expect(row).toContainText(`Replacement · from ${own}`);
    await expect(page.getByText(/· 1 of 5 seats$/)).toBeVisible();
  });

  test("the admin overrides the booking onto another lesson", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await expect(page.getByText(/replacements? to review$/)).toBeVisible();
    await page.goto("/admin/absences?tab=review");
    await expect(
      page.getByRole("link", { name: /^Review \(\d+\)$/ }),
    ).toHaveAttribute("aria-current", "page");
    const row = page.getByRole("row").filter({ hasText: STUDENT });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Override…" }).click();
    const dialog = page.getByRole("dialog", {
      name: `Override ${STUDENT}'s booking`,
    });
    await dialog.locator(`input[type=radio][value="${ids.moved}"]`).check();
    await dialog
      .getByLabel("Reason (required)")
      .fill("Moved to Friday at the student's request.");
    await dialog.getByRole("button", { name: "Save override" }).click();
    await expect(page.getByText(/^Booking moved to /)).toBeVisible();
    await expect(row).toHaveCount(0);

    // The Replacements tab shows it overridden, by whom.
    await page.goto(
      `/admin/absences?tab=replacements&student=${ids.student}&from=${today}&to=${addDays(today, 14)}`,
    );
    const overridden = page.getByRole("row").filter({ hasText: STUDENT });
    await expect(overridden).toContainText("Overridden");
    await expect(overridden).toContainText(/Reviewed by .*,/);

    const [booking] = await sql<{ target: string; status: string }>(
      `SELECT target_lesson_id AS target, status FROM replacement_requests
       WHERE student_id = $1`,
      [ids.student],
    );
    expect(booking).toEqual({ target: ids.moved, status: "OVERRIDDEN" });
  });

  test("teachers and admins can't run any student action", async ({
    browser,
  }) => {
    const FILE = "src/app/student/absences/actions.ts";
    const calls: [string, unknown[]][] = [
      ["cancelLessonAction", [{ lessonId: ids.missed, reason: null }]],
      [
        "bookReplacementAction",
        [{ creditId: ids.missed, targetLessonId: ids.target }],
      ],
      ["cancelBookingAction", [{ bookingId: ids.target }]],
      ["loadRescheduleSheetAction", [{ lessonId: ids.missed }]],
      [
        "rescheduleLessonAction",
        [{ lessonId: ids.missed, startsAt: currentTime().toISOString() }],
      ],
    ];
    // Every absence action is listed here. The rating action (CARM-66)
    // is covered by the Phase 5 permission suite (CARM-67).
    expect(calls.map(([name]) => `${FILE}#${name}`).sort()).toEqual(
      serverActionsIn("src/app/student/absences").sort(),
    );
    for (const [email, home] of [
      [DEMO_LOGINS.teacher, "/teacher"],
      [DEMO_LOGINS.admin, "/admin"],
    ] as const) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await signIn(page, email);
      await page.waitForURL(home);
      for (const [name, args] of calls) {
        const { status, result } = await callAction(page, [FILE, name], args);
        expect(status, `${email} ${name}`).toBeGreaterThanOrEqual(400);
        expect(result, `${email} ${name}`).toBeNull();
      }
      await context.close();
    }
  });
});
