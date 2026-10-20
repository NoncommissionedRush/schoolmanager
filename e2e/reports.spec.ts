import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { addDays, zonedTimeToUtc } from "../src/server/scheduling/time";
import { TODAY } from "./clock";
import { DEMO_LOGINS, signIn, sql } from "./helpers";

// Happy path of CARM-73 (docs/design/reports.md §4): the admin opens the
// attendance and teacher-hours reports from the nav, narrows a filter,
// opens one teacher's lessons and exports each CSV. Runs in its own school
// so the figures are exact whatever the other specs do. The permission
// cases (teacher / student / other school) are CARM-74's suite; this only
// checks the export route's 401 / 403 / 422 answers once.
test.describe("reports", () => {
  test.describe.configure({ mode: "serial" });
  const TZ = "Europe/Bratislava";
  const suffix = randomUUID().slice(0, 8);
  const today = TODAY;
  const emails = {
    admin: `e2e-rep-a-${suffix}@demo-school.test`,
    teacher: `e2e-rep-t-${suffix}@demo-school.test`,
    sub: `e2e-rep-u-${suffix}@demo-school.test`,
    sara: `e2e-rep-s-${suffix}@demo-school.test`,
    pavol: `e2e-rep-p-${suffix}@demo-school.test`,
  };
  const names = {
    teacher: `Theo Teacher ${suffix}`,
    sub: `Uma Substitute ${suffix}`,
    sara: `Sara Student ${suffix}`,
    pavol: `Pavol Student ${suffix}`,
  };
  const groupName = `E2E Reports ${suffix}`;
  const ids = {
    school: randomUUID(),
    term: randomUUID(),
    level: randomUUID(),
    group: randomUUID(),
    room: randomUUID(),
    users: {
      admin: randomUUID(),
      teacher: randomUUID(),
      sub: randomUUID(),
      sara: randomUUID(),
      pavol: randomUUID(),
    },
    teacher: randomUUID(),
    sub: randomUUID(),
    sara: randomUUID(),
    pavol: randomUUID(),
  };
  // Three ended 45-minute lessons (the second covered by Uma), one ahead.
  const lessonDates = [-14, -7, -3, 4].map((d) => addDays(today, d));
  const lessonIds = lessonDates.map(() => randomUUID());
  const termStart = addDays(today, -40);
  const termEnd = addDays(today, 30);

  test.beforeAll(async () => {
    const [{ hash }] = await sql<{ hash: string }>(
      "SELECT password_hash AS hash FROM users WHERE email = $1",
      [DEMO_LOGINS.admin],
    );
    await sql(
      `INSERT INTO schools (id, name, slug, timezone, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [ids.school, `E2E Reports ${suffix}`, `e2e-reports-${suffix}`, TZ],
    );
    const people = [
      [ids.users.admin, emails.admin, "Ada Admin", "ADMIN"],
      [ids.users.teacher, emails.teacher, names.teacher, "TEACHER"],
      [ids.users.sub, emails.sub, names.sub, "TEACHER"],
      [ids.users.sara, emails.sara, names.sara, "STUDENT"],
      [ids.users.pavol, emails.pavol, names.pavol, "STUDENT"],
    ] as const;
    for (const [id, email, name, role] of people) {
      await sql(
        `INSERT INTO users (id, email, name, password_hash, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [id, email, name, hash],
      );
      await sql(
        `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [ids.school, id, role],
      );
    }
    await sql(
      `INSERT INTO levels (id, school_id, code, name, rank, updated_at)
       VALUES ($1, $2, 'B1', 'Intermediate', 1, now())`,
      [ids.level, ids.school],
    );
    for (const [id, user] of [
      [ids.teacher, ids.users.teacher],
      [ids.sub, ids.users.sub],
    ]) {
      await sql(
        `INSERT INTO teacher_profiles (id, school_id, user_id, updated_at)
         VALUES ($1, $2, $3, now())`,
        [id, ids.school, user],
      );
    }
    for (const [id, user] of [
      [ids.sara, ids.users.sara],
      [ids.pavol, ids.users.pavol],
    ]) {
      await sql(
        `INSERT INTO student_profiles (id, school_id, user_id, level_id, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [id, ids.school, user, ids.level],
      );
    }
    await sql(
      `INSERT INTO terms (id, school_id, name, start_date, end_date, timetable_published_at, updated_at)
       VALUES ($1, $2, 'E2E Term', $3, $4, now(), now())`,
      [ids.term, ids.school, termStart, termEnd],
    );
    await sql(
      `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at)
       VALUES ($1, $2, $3, 'GROUP', $4, 8, now())`,
      [ids.group, ids.school, ids.level, groupName],
    );
    await sql(
      `INSERT INTO rooms (id, school_id, name, kind, capacity, updated_at)
       VALUES ($1, $2, 'Room 7', 'PHYSICAL', 8, now())`,
      [ids.room, ids.school],
    );
    for (const student of [ids.sara, ids.pavol]) {
      await sql(
        `INSERT INTO group_memberships (id, school_id, group_id, student_id, joined_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
        [ids.school, ids.group, student, zonedTimeToUtc(termStart, 0, TZ)],
      );
    }
    for (const [i, date] of lessonDates.entries()) {
      await sql(
        `INSERT INTO lessons (id, school_id, term_id, group_id, teacher_id, substitute_teacher_id, room_id, starts_at, ends_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8::timestamptz + interval '45 minutes', now())`,
        [
          lessonIds[i],
          ids.school,
          ids.term,
          ids.group,
          ids.teacher,
          i === 1 ? ids.sub : null,
          ids.room,
          zonedTimeToUtc(date, 6 * 60, TZ),
        ],
      );
    }
    // Pavol cancelled the first lesson too late for a credit.
    await sql(
      `INSERT INTO absence_reports (id, school_id, lesson_id, student_id, reported_by_id, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
      [ids.school, lessonIds[0], ids.pavol, ids.users.pavol],
    );
  });

  test.afterAll(async () => {
    await sql("DELETE FROM lessons WHERE school_id = $1", [ids.school]);
    await sql("DELETE FROM schools WHERE id = $1", [ids.school]);
    await sql("DELETE FROM users WHERE id = ANY($1)", [
      Object.values(ids.users),
    ]);
  });

  test("the admin reads both reports and exports them", async ({ page }) => {
    await signIn(page, emails.admin);
    await page.waitForURL("/admin");
    await page.getByRole("link", { name: "Reports", exact: true }).click();
    await page.waitForURL("/admin/reports");

    // Attendance.
    await page.getByRole("link", { name: "Open report: Attendance" }).click();
    await page.waitForURL("/admin/reports/attendance");
    await expect(
      page.getByText(
        "Based on reported absences. Attendance is not taken in class.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "The period goes past today, so it shows lessons until today.",
      ),
    ).toBeVisible();
    const pavol = page.getByRole("row").filter({ hasText: names.pavol });
    await expect(pavol.getByRole("cell")).toHaveText([
      names.pavol,
      `${groupName}B1`,
      "3",
      "10 with credit · 1 late",
      "2",
      "66.7 %",
      "0",
    ]);
    await expect(
      page.getByRole("row").filter({ hasText: names.sara }),
    ).toContainText("100.0 %");
    // Totals cover every row: 6 expected, 5 attended (83.3 %).
    await expect(page.locator("tfoot")).toContainText("83.3 %");

    // A filter lives in the URL and narrows the rows.
    await page
      .getByRole("combobox", { name: "Student" })
      .selectOption({ label: names.sara });
    await page.waitForURL(/student=/);
    await expect(
      page.getByRole("row").filter({ hasText: names.pavol }),
    ).toHaveCount(0);

    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Export CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(
      `attendance_${termStart}_${termEnd}.csv`,
    );
    const csv = await readFile((await file.path())!, "utf8");
    expect(csv).toBe(
      "﻿Student,Group,Level,Expected,Absent,Absent with credit,Absent late,Attended,Attendance %,Makeups attended\r\n" +
        `${names.sara},${groupName},B1,3,0,0,0,3,100.0,0\r\n`,
    );
    await expect(page.getByText("Export downloaded.")).toBeVisible();

    // Teacher hours: the covered lesson counts for the substitute.
    await page
      .getByRole("link", { name: "Reports", exact: true })
      .first()
      .click();
    await page
      .getByRole("link", { name: "Open report: Teacher hours" })
      .click();
    await page.waitForURL("/admin/reports/teacher-hours");
    const theo = page.getByRole("row").filter({ hasText: names.teacher });
    await expect(theo.getByRole("cell")).toHaveText([
      names.teacher,
      "2",
      "1 h 30 min",
      "0 h",
      "1 h 30 min",
      "45 min",
    ]);
    const uma = page.getByRole("row").filter({ hasText: names.sub });
    await expect(uma.getByRole("cell")).toHaveText([
      names.sub,
      "1",
      "0 h",
      "45 min",
      "45 min",
      "0 h",
    ]);
    await expect(page.locator("dl").filter({ visible: true })).toContainText(
      "2 h 15 min",
    );

    const summary = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    await page.getByRole("menuitem", { name: "Summary" }).click();
    const summaryCsv = await readFile((await (await summary).path())!, "utf8");
    expect(summaryCsv.split("\r\n")).toEqual([
      "﻿Teacher,Lessons,Regular minutes,Substitute minutes,Total minutes,Hours,Covered by others minutes",
      `${names.teacher},2,90,0,90,1.50,45`,
      `${names.sub},1,0,45,45,0.75,0`,
      "",
    ]);

    // One teacher's lessons.
    await uma.getByRole("link", { name: names.sub }).click();
    await page.waitForURL(`/admin/reports/teacher-hours/${ids.sub}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(names.sub);
    await expect(
      page.getByRole("row").filter({ hasText: groupName }),
    ).toContainText(`Substitute for ${names.teacher}`);
    const details = page.waitForEvent("download");
    await page.getByRole("link", { name: "Export CSV" }).click();
    const detailsCsv = await readFile((await (await details).path())!, "utf8");
    expect(detailsCsv.split("\r\n")[1]).toBe(
      `${lessonDates[1]},06:00,06:45,45,${names.sub},SUBSTITUTE,${names.teacher},${groupName},B1,Room 7,${lessonIds[1]}`,
    );
  });

  test("the export route refuses bad periods, other roles and signed-out requests", async ({
    browser,
    request,
  }) => {
    const path = "/api/admin/reports/attendance.csv";
    expect((await request.get(path)).status()).toBe(401);

    const admin = await browser.newPage();
    await signIn(admin, emails.admin);
    await admin.waitForURL("/admin");
    const tooLong = await admin.request.get(
      `${path}?from=2026-01-01&to=2027-01-02`,
    );
    expect(tooLong.status()).toBe(422);
    expect(await tooLong.json()).toEqual({ code: "RANGE_TOO_LONG" });
    expect(
      (await admin.request.get(`${path}?teacher=${randomUUID()}`)).status(),
    ).toBe(404);
    expect(
      (await admin.request.get("/api/admin/reports/payments.csv")).status(),
    ).toBe(404);
    await admin.goto("/admin/reports/attendance?from=2026-01-01&to=2027-01-02");
    await expect(
      admin.getByText("Choose a period of at most 366 days."),
    ).toBeVisible();
    await admin.close();

    const teacher = await browser.newPage();
    await signIn(teacher, emails.teacher);
    await teacher.waitForURL("/teacher");
    expect((await teacher.request.get(path)).status()).toBe(403);
    await teacher.close();

    const student = await browser.newPage();
    await signIn(student, emails.sara);
    await student.waitForURL("/student");
    expect((await student.request.get(path)).status()).toBe(403);
    await student.close();
  });
});
