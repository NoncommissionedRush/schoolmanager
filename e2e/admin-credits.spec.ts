import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

import {
  addDays,
  toZonedDateTime,
  zonedTimeToUtc,
} from "../src/server/scheduling/time";
import { DEMO_LOGINS, signIn, sql } from "./helpers";

// Happy path of CARM-47: an admin spends a student's makeup credits for
// them — a group credit on a replacement, a 1-on-1 credit on a new lesson —
// and the teacher dashboard's Today list shows "−n · +r" for a lesson with
// a cancellation (absences.md §6.3). Runs on its own term, groups, rooms,
// teacher, student and lessons, so it doesn't depend on the seeded data.
test.describe("admin spends a student's credits; teacher Today counts", () => {
  test.describe.configure({ mode: "serial" });
  const TZ = "Europe/Bratislava";
  const suffix = randomUUID().slice(0, 8);
  const own = `E2E Credit Own ${suffix}`;
  const other = `E2E Credit Other ${suffix}`;
  const oneOnOne = `E2E Credit 1-on-1 ${suffix}`;
  const STUDENT = `Cleo Credit ${suffix}`;
  const ids = {
    term: randomUUID(),
    own: randomUUID(),
    other: randomUUID(),
    oneOnOne: randomUUID(),
    room: randomUUID(),
    booth: randomUUID(),
    user: randomUUID(),
    student: randomUUID(),
    teacherUser: randomUUID(),
    teacher: randomUUID(),
    missed: randomUUID(), // own group, in three days 10:00: group credit
    target: randomUUID(), // other group, in four days 14:00
    oneMissed: randomUUID(), // 1-on-1, in three days 16:00: 1-on-1 credit
    today: randomUUID(), // own group, today 23:00: the student cancelled
  };
  const today = toZonedDateTime(new Date(), TZ).date;
  const missedDate = addDays(today, 3);
  const newDate = addDays(today, 5);
  // The credits are valid until the day before this (expiry at its start).
  const expiryDate = addDays(today, 30);
  let school: string;

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
    school = row.school;
    await sql(
      `INSERT INTO terms (id, school_id, name, start_date, end_date, timetable_published_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())`,
      [ids.term, school, own, addDays(today, -7), addDays(today, 30)],
    );
    await sql(
      `INSERT INTO rooms (id, school_id, name, kind, capacity, updated_at)
       VALUES ($1, $3, $4, 'PHYSICAL', 5, now()), ($2, $3, $5, 'PHYSICAL', 1, now())`,
      [
        ids.room,
        ids.booth,
        school,
        `E2E Room ${suffix}`,
        `E2E Booth ${suffix}`,
      ],
    );
    // The 1-on-1's own teacher, so the new lesson can't clash with the
    // demo teacher's timetable.
    await sql(
      `INSERT INTO users (id, email, name, password_hash, updated_at)
       VALUES ($1, $2, $3, $4, now()), ($5, $6, $7, $4, now())`,
      [
        ids.user,
        `e2e-credit-${suffix}@demo-school.test`,
        STUDENT,
        row.hash,
        ids.teacherUser,
        `e2e-credit-teacher-${suffix}@demo-school.test`,
        `Theo Credit ${suffix}`,
      ],
    );
    await sql(
      `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'STUDENT', now()),
              (gen_random_uuid(), $1, $3, 'TEACHER', now())`,
      [school, ids.user, ids.teacherUser],
    );
    await sql(
      `INSERT INTO teacher_profiles (id, school_id, user_id, updated_at)
       VALUES ($1, $2, $3, now())`,
      [ids.teacher, school, ids.teacherUser],
    );
    await sql(
      `INSERT INTO student_profiles (id, school_id, user_id, level_id, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [ids.student, school, ids.user, row.level],
    );
    await sql(
      `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at)
       VALUES ($1, $4, $5, 'GROUP', $6, 8, now()),
              ($2, $4, $5, 'GROUP', $7, 8, now()),
              ($3, $4, $5, 'ONE_ON_ONE', $8, 1, now())`,
      [
        ids.own,
        ids.other,
        ids.oneOnOne,
        school,
        row.level,
        own,
        other,
        oneOnOne,
      ],
    );
    await sql(
      `INSERT INTO group_memberships (id, school_id, group_id, student_id, joined_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $4, now() - interval '1 day', now()),
              (gen_random_uuid(), $1, $3, $4, now() - interval '1 day', now())`,
      [school, ids.own, ids.oneOnOne, ids.student],
    );
    const lessons: [string, string, string, string, Date, number, string][] = [
      [
        ids.missed,
        ids.own,
        row.teacher,
        ids.room,
        zonedTimeToUtc(missedDate, 10 * 60, TZ),
        90,
        "SCHEDULED",
      ],
      [
        ids.target,
        ids.other,
        row.teacher,
        ids.room,
        zonedTimeToUtc(addDays(today, 4), 14 * 60, TZ),
        90,
        "SCHEDULED",
      ],
      [
        ids.oneMissed,
        ids.oneOnOne,
        ids.teacher,
        ids.booth,
        zonedTimeToUtc(missedDate, 16 * 60, TZ),
        45,
        "CANCELLED",
      ],
      [
        // On the spec's own teacher: the demo teacher's dashboard, which
        // other specs open in parallel, never loads this spec's rows.
        ids.today,
        ids.own,
        ids.teacher,
        ids.room,
        zonedTimeToUtc(today, 23 * 60, TZ),
        45,
        "SCHEDULED",
      ],
    ];
    for (const [
      id,
      group,
      teacher,
      room,
      startsAt,
      minutes,
      status,
    ] of lessons) {
      await sql(
        `INSERT INTO lessons (id, school_id, term_id, group_id, teacher_id, room_id, starts_at, ends_at, status, cancel_reason, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7::timestamptz + make_interval(mins => $8), $9::"LessonStatus",
                 CASE WHEN $9 = 'CANCELLED' THEN 'STUDENT_CANCELLED' END, now())`,
        [id, school, ids.term, group, teacher, room, startsAt, minutes, status],
      );
    }
    // The student cancelled the two missed lessons in time (a credit each)
    // and tonight's lesson late (no credit).
    for (const lesson of [ids.missed, ids.oneMissed, ids.today]) {
      const absence = randomUUID();
      await sql(
        `INSERT INTO absence_reports (id, school_id, lesson_id, student_id, reported_by_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())`,
        [absence, school, lesson, ids.student, ids.user],
      );
      if (lesson === ids.today) continue;
      await sql(
        `INSERT INTO makeup_credits (id, school_id, student_id, source_lesson_id, absence_report_id, expires_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())`,
        [
          school,
          ids.student,
          lesson,
          absence,
          zonedTimeToUtc(expiryDate, 0, TZ),
        ],
      );
    }
  });

  test.afterAll(async () => {
    await sql("DELETE FROM replacement_requests WHERE student_id = $1", [
      ids.student,
    ]);
    await sql("DELETE FROM makeup_credits WHERE student_id = $1", [
      ids.student,
    ]);
    await sql("DELETE FROM absence_reports WHERE student_id = $1", [
      ids.student,
    ]);
    // The booked 1-on-1 first: it points back at the missed one.
    await sql(
      "DELETE FROM lessons WHERE group_id = $1 AND rescheduled_from_id IS NOT NULL",
      [ids.oneOnOne],
    );
    await sql("DELETE FROM lessons WHERE term_id = $1", [ids.term]);
    await sql("DELETE FROM group_memberships WHERE student_id = $1", [
      ids.student,
    ]);
    await sql("DELETE FROM groups WHERE id = ANY($1)", [
      [ids.own, ids.other, ids.oneOnOne],
    ]);
    await sql("DELETE FROM student_profiles WHERE id = $1", [ids.student]);
    await sql("DELETE FROM teacher_profiles WHERE id = $1", [ids.teacher]);
    await sql("DELETE FROM memberships WHERE user_id = ANY($1)", [
      [ids.user, ids.teacherUser],
    ]);
    await sql("DELETE FROM users WHERE id = ANY($1)", [
      [ids.user, ids.teacherUser],
    ]);
    await sql("DELETE FROM rooms WHERE id = ANY($1)", [[ids.room, ids.booth]]);
    await sql("DELETE FROM terms WHERE id = $1", [ids.term]);
  });

  /** The admin's Absences tab, filtered to the student. */
  async function absenceRow(page: Page, group: string) {
    await page.goto(
      `/admin/absences?tab=absences&student=${ids.student}&from=${today}&to=${addDays(today, 14)}`,
    );
    // The absence with an available credit (tonight's late one has none).
    const row = page
      .getByRole("row")
      .filter({ hasText: group })
      .filter({ hasText: "Available until" });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Actions" }).click();
    return row;
  }

  test("the admin books a replacement with the student's group credit", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await absenceRow(page, own);
    await page.getByRole("menuitem", { name: "Book replacement…" }).click();
    const dialog = page.getByRole("dialog", {
      name: `Book a replacement for ${STUDENT}`,
    });
    await dialog.locator(`input[type=radio][value="${ids.target}"]`).check();
    await dialog.getByLabel("Note (optional)").fill("Phoned the office.");
    await dialog.getByRole("button", { name: "Book replacement" }).click();
    await expect(page.getByText(/^Replacement booked for /)).toBeVisible();

    const [booking] = await sql<{ target: string; status: string }>(
      `SELECT target_lesson_id AS target, status FROM replacement_requests
       WHERE student_id = $1`,
      [ids.student],
    );
    expect(booking).toEqual({ target: ids.target, status: "APPROVED" });
  });

  test("the admin books a 1-on-1 with the student's 1-on-1 credit", async ({
    page,
  }) => {
    await signIn(page, DEMO_LOGINS.admin);
    await page.waitForURL("/admin");
    await absenceRow(page, oneOnOne);
    await page
      .getByRole("menuitem", { name: "Book 1-on-1 with credit…" })
      .click();
    const dialog = page.getByRole("dialog", {
      name: `Book a 1-on-1 for ${STUDENT}`,
    });
    const save = dialog.getByRole("button", { name: "Book lesson" });
    const expiryTick = dialog.getByRole("checkbox", {
      name: "I've checked: After the credit expires.",
    });
    // On the expiry day the admin has to acknowledge it …
    await dialog.getByLabel("Date").fill(expiryDate);
    await dialog.getByLabel("Start time").fill("16:00");
    await save.click();
    await expect(expiryTick).toBeVisible();

    // … before it, not. The new teacher has no availability set, so other
    // overridable problems may come back: acknowledge those and save again.
    await dialog.getByLabel("Date").fill(newDate);
    await save.click();
    const done = page.getByText(/^Lesson booked for /);
    const ticks = dialog.getByRole("checkbox");
    await expect(done.or(ticks.first())).toBeVisible();
    if (!(await done.isVisible())) {
      await expect(expiryTick).toBeHidden();
      for (const tick of await ticks.all()) await tick.check();
      await save.click();
    }
    await expect(done).toBeVisible();
    await page.waitForURL(/\/admin\/lessons\//);

    const [lesson] = await sql<{ from: string; credit: string }>(
      `SELECT l.rescheduled_from_id AS from, c.status AS credit
       FROM lessons l JOIN makeup_credits c ON c.rescheduled_lesson_id = l.id
       WHERE l.group_id = $1 AND l.rescheduled_from_id IS NOT NULL`,
      [ids.oneOnOne],
    );
    expect(lesson).toEqual({ from: ids.oneMissed, credit: "USED" });
  });

  test("the teacher's Today list shows who isn't coming", async ({ page }) => {
    await signIn(page, `e2e-credit-teacher-${suffix}@demo-school.test`);
    await page.waitForURL("/teacher");
    const card = page
      .getByRole("heading", { name: "Today", exact: true })
      .locator("xpath=ancestor::*[@data-slot='card'][1]");
    const row = card.getByRole("listitem").filter({ hasText: own });
    await expect(row).toContainText("−1 · +0");
    await expect(row).toContainText("1 not coming, 0 replacements");
  });
});
