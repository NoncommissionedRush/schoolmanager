import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { DEMO_LOGINS, sql } from "../helpers";
import { callAction, FormFields } from "../server-actions";
import { teacherAvailabilityCases } from "./action-cases";
import { LOGINS, SCHOOL_A, signedIn } from "./fixtures";

// Availability change requests (CARM-86, docs/design/availability-requests.md
// §5): a teacher only proposes changes to their own availability and only
// withdraws their own requests; only an admin of the same school decides.
// The target is a teacher of school A made here, with one rule and one
// pending request; every refused call must leave both untouched.
test.describe("permissions › availability requests", () => {
  const suffix = randomUUID().slice(0, 8);
  const ids = {
    school: "",
    user: randomUUID(),
    teacher: randomUUID(),
    rule: randomUUID(),
    request: randomUUID(),
  };

  const state = async () =>
    sql(
      `SELECT
         (SELECT row_to_json(a) FROM teacher_availability a WHERE id = $1) AS rule,
         (SELECT row_to_json(r) FROM availability_requests r WHERE id = $2) AS request,
         (SELECT count(*)::int FROM availability_requests WHERE teacher_id = $3) AS requests`,
      [ids.rule, ids.request, ids.teacher],
    );

  test.beforeAll(async () => {
    const [row] = await sql<{ school: string; hash: string }>(
      `SELECT s.id AS school, u.password_hash AS hash
       FROM schools s JOIN users u ON u.email = $2
       WHERE s.slug = $1`,
      [SCHOOL_A, DEMO_LOGINS.teacher],
    );
    ids.school = row.school;
    await sql(
      `INSERT INTO users (id, email, name, password_hash, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [
        ids.user,
        `e2e-avr-${suffix}@demo-school.test`,
        `Vera Victim ${suffix}`,
        row.hash,
      ],
    );
    await sql(
      `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'TEACHER', now())`,
      [ids.school, ids.user],
    );
    await sql(
      `INSERT INTO teacher_profiles (id, school_id, user_id, updated_at)
       VALUES ($1, $2, $3, now())`,
      [ids.teacher, ids.school, ids.user],
    );
    await sql(
      `INSERT INTO teacher_availability
         (id, school_id, teacher_id, kind, weekday, start_minute, end_minute, updated_at)
       VALUES ($1, $2, $3, 'WEEKLY_UNAVAILABLE', 2, 480, 600, now())`,
      [ids.rule, ids.school, ids.teacher],
    );
    await sql(
      `INSERT INTO availability_requests
         (id, school_id, teacher_id, kind, payload, updated_at)
       VALUES ($1, $2, $3, 'ADD_WEEKLY',
               '{"weekly":{"weekdays":[4],"startMinute":480,"endMinute":540,"note":null}}',
               now())`,
      [ids.request, ids.school, ids.teacher],
    );
  });

  test.afterAll(async () => {
    await sql("DELETE FROM teacher_profiles WHERE id = $1", [ids.teacher]);
    await sql("DELETE FROM memberships WHERE user_id = $1", [ids.user]);
    await sql("DELETE FROM users WHERE id = $1", [ids.user]);
  });

  const cases = () =>
    teacherAvailabilityCases({ availability: ids.rule, request: ids.request });

  for (const [who, email] of [
    ["a colleague in the same school", LOGINS.A.teacher],
    ["a teacher of another school", LOGINS.B.teacher],
  ] as const) {
    test(`${who} can't touch the teacher's rules or requests`, async ({
      browser,
    }) => {
      const page = await signedIn(browser, email, "teacher");
      await page.goto("/teacher/availability");
      const before = await state();
      for (const c of cases()) {
        const { status, result } = await callAction(page, c.action, c.args);
        expect(status, c.name).toBe(200);
        expect(result?.formError, c.name).toMatchObject({
          key: "common.error.notFound",
        });
      }
      expect(await state()).toEqual(before);
    });
  }

  test("an admin of another school can't decide the request", async ({
    browser,
  }) => {
    const page = await signedIn(browser, LOGINS.B.admin, "admin");
    const before = await state();
    const actions = "src/app/admin/teachers/actions.ts";
    for (const [name, args] of [
      ["approveAvailabilityRequestAction", [ids.teacher, ids.request]],
      [
        "rejectAvailabilityRequestAction",
        [ids.teacher, ids.request, null, new FormFields({ note: "x" })],
      ],
    ] as const) {
      const { status, result } = await callAction(
        page,
        [actions, name],
        [...args],
      );
      expect(status, name).toBe(200);
      expect(result?.formError, name).toMatchObject({
        key: "common.error.notFound",
      });
    }
    expect(await state()).toEqual(before);
  });

  test("a student is refused by the teacher's actions", async ({ browser }) => {
    const page = await signedIn(browser, LOGINS.A.student, "student");
    const before = await state();
    for (const c of cases()) {
      // The proxy refuses /teacher for students, before the action runs.
      const { status, result } = await callAction(page, c.action, c.args);
      expect(result, c.name).toBeNull();
      expect(status, c.name).not.toBe(200);
    }
    expect(await state()).toEqual(before);
  });
});
