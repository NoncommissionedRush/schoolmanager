import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { DEMO_PASSWORD, signIn, sql } from "../helpers";
import { hashPassword } from "../../src/server/auth/password";
import { type ActionCase, crossSchoolCases } from "./action-cases";
import {
  expectNoneOf,
  LOGINS,
  SCHOOL_A,
  type SchoolIds,
  schoolIds,
  serverResponse,
  signedIn,
  WEEK,
} from "./fixtures";
import {
  callAction,
  compiledServerActions,
  FormFields,
} from "../server-actions";

// Role boundaries inside one school (CARM-26): teachers and students can't
// open admin pages or run admin actions, students only see their own
// groups' lessons, teachers only the lessons they teach.

let a: SchoolIds;

test.beforeAll(async () => {
  a = await schoolIds(SCHOOL_A);
});

const adminPages = (ids: SchoolIds) => [
  "/admin",
  "/admin/teachers",
  `/admin/teachers/${ids.teacher}`,
  "/admin/students",
  `/admin/students/${ids.student}`,
  "/admin/groups",
  `/admin/groups/${ids.group}`,
  "/admin/lessons",
  `/admin/lessons/${ids.lesson}`,
  "/admin/levels",
  "/admin/settings",
  "/admin/settings/admins",
  "/admin/settings/rooms",
  "/admin/settings/terms",
  "/admin/settings/school",
  "/admin/settings/absences",
  "/admin/absences",
  "/admin/absences?tab=review",
  "/admin/absences?tab=replacements",
  `/admin/timetable?week=${WEEK}`,
  `/admin/timetable/edit?term=${ids.term}`,
  // Phase 5 (CARM-65, CARM-66)
  "/admin/notifications",
  "/admin/substitutions",
  `/admin/substitutions?teacher=${ids.teacher}`,
  "/admin/ratings",
  `/admin/ratings/${ids.teacher}`,
];

const FORBIDDEN = "You don't have access to this page";

/** The forbidden page was served, with a 403. */
function expectForbidden(
  { status, body }: { status: number; body: string },
  path: string,
) {
  expect(status, path).toBe(403);
  expect(body, path).toContain("have access to this page");
}

/** Admin actions without an id to aim at (they create or change settings). */
const unaimedCases = (ids: SchoolIds): ActionCase[] => [
  {
    name: "create a teacher",
    action: ["src/app/admin/teachers/actions.ts", "createTeacherAction"],
    args: [
      null,
      formOf({
        name: "Role Leak",
        email: `role.leak.${randomUUID()}@example.test`,
        password: "Role-leak-password-1",
      }),
    ],
  },
  {
    name: "create a student",
    action: ["src/app/admin/students/actions.ts", "createStudentAction"],
    args: [
      null,
      formOf({
        name: "Role Leak",
        email: `role.leak.${randomUUID()}@example.test`,
        password: "Role-leak-password-1",
      }),
    ],
  },
  {
    name: "create an admin",
    action: ["src/app/admin/settings/admins/actions.ts", "createAdminAction"],
    args: [
      null,
      formOf({
        name: "Role Leak",
        email: `role.leak.${randomUUID()}@example.test`,
        password: "Role-leak-password-1",
      }),
    ],
  },
  {
    name: "add the CEFR levels",
    action: ["src/app/admin/levels/actions.ts", "addCefrPresetAction"],
    args: [],
  },
  {
    name: "change school settings",
    action: [
      "src/app/admin/settings/school/actions.ts",
      "saveSchoolSettingsAction",
    ],
    args: [
      null,
      formOf({
        name: "Role Leak School",
        timezone: "Europe/London",
        teachingWeekdays: "1",
        dayStart: "07:00",
        dayEnd: "21:00",
      }),
    ],
  },
  {
    name: "change the absence settings",
    action: [
      "src/app/admin/settings/absences/actions.ts",
      "saveAbsenceSettingsAction",
    ],
    args: [null, formOf({ cutoffHours: "1", validDays: "1" })],
  },
  {
    name: "create a room",
    action: ["src/app/admin/settings/rooms/actions.ts", "saveRoomAction"],
    args: [
      null,
      null,
      formOf({
        name: `Role Leak ${randomUUID()}`,
        kind: "PHYSICAL",
        capacity: "5",
      }),
    ],
  },
  {
    name: "create a term",
    action: ["src/app/admin/settings/terms/actions.ts", "saveTermAction"],
    args: [
      null,
      null,
      formOf({
        name: `Role Leak ${randomUUID()}`,
        startDate: "2028-01-03",
        endDate: "2028-01-28",
      }),
    ],
  },
  {
    name: "edit a teacher's own record",
    action: ["src/app/admin/teachers/actions.ts", "updateTeacherAction"],
    args: [
      ids.teacher,
      null,
      formOf({ name: "Role Leak", email: LOGINS.A.teacher, color: "blue" }),
    ],
  },
  // Assign teachers (CARM-56). Valid inputs on school A's own data; the
  // cross-school cases arrive with the Phase 4 permission suite (CARM-57).
  {
    name: "set a group's lesson times",
    action: [GROUP_ACTIONS, "saveLessonTimesAction"],
    args: [
      ids.group,
      {
        times: [
          {
            weekday: 6,
            startMinute: 600,
            endMinute: 660,
            roomId: ids.room,
          },
        ],
      },
    ],
  },
  {
    name: "set a teacher's levels",
    action: ["src/app/admin/teachers/actions.ts", "saveTeacherLevelsAction"],
    args: [ids.teacher, { levelIds: [ids.level], maxHours: 1 }],
  },
  ...generatorCases(ids),
];

const GROUP_ACTIONS = "src/app/admin/groups/actions.ts";
const GENERATOR = "src/app/admin/timetable/generator-actions.ts";

/**
 * Every generator action with valid input. Draft and run ids are the term's
 * id: the role is checked before any of them is looked up.
 */
function generatorCases(ids: SchoolIds): ActionCase[] {
  const draft = ids.term;
  const call = (action: string, ...args: unknown[]): ActionCase => ({
    name: `generator: ${action}`,
    action: [GENERATOR, action],
    args,
  });
  return [
    call("checkReadinessAction", { termId: ids.term }),
    call("setGroupSkippedAction", {
      termId: ids.term,
      groupId: ids.group,
      skipped: true,
    }),
    call("startRunAction", { termId: ids.term, mode: "FILL" }),
    call("getRunAction", draft),
    call("cancelRunAction", draft),
    call("getDraftAction", ids.term),
    call("teacherOptionsAction", { draftId: draft, groupId: ids.group }),
    call("saveAssignmentAction", {
      draftId: draft,
      version: 0,
      groupId: ids.group,
      teacherId: ids.teacher,
    }),
    call("setAssignmentsLockedAction", {
      draftId: draft,
      version: 0,
      groupIds: [ids.group],
      locked: true,
    }),
    call("checkDraftAction", draft),
    call("previewApplyAction", { draftId: draft, publish: false }),
    call("applyDraftAction", {
      draftId: draft,
      version: 0,
      acknowledgedConflictKeys: [],
      publish: false,
    }),
    call("discardDraftAction", draft),
  ];
}

/** Every admin action, aimed at school A's own data. */
const allAdminCases = (ids: SchoolIds) => [
  ...crossSchoolCases(ids, ids),
  ...unaimedCases(ids),
];

function formOf(fields: Record<string, string>) {
  return new FormFields(fields);
}

/** The data the cases could touch, as text: compare before and after. */
async function snapshot(ids: SchoolIds) {
  const rows: Record<string, string> = {};
  const tables: [string, string][] = [
    ["users", ids.adminUser],
    ["users", ids.teacherUser],
    ["users", ids.studentUser],
    ["teacher_profiles", ids.teacher],
    ["student_profiles", ids.student],
    ["groups", ids.group],
    ["group_memberships", ids.groupMembership],
    ["timetable_slots", ids.slot],
    ["terms", ids.term],
    ["rooms", ids.room],
    ["levels", ids.level],
    ["courses", ids.course],
    ["holidays", ids.holiday],
    ["teacher_availability", ids.availability],
    ["absence_reports", ids.absence],
    ["replacement_requests", ids.replacement],
    ["schools", ids.school],
  ];
  for (const [table, id] of tables) {
    const [row] = await sql<{ row: string }>(
      `SELECT t::text AS row FROM ${table} t WHERE id = $1`,
      [id],
    );
    rows[`${table}:${id}`] = row?.row ?? "missing";
  }
  // Levels: E2E-% codes belong to specs running in parallel (admin-actions
  // adds and removes E2E-LEAK in this school), so they're left out. Lessons:
  // only the seeded groups' (deterministic v5 ids); specs running in
  // parallel add lessons of their own groups to the same term.
  const [counts] = await sql<{ row: string }>(
    `SELECT row(
       (SELECT count(*) FROM users WHERE name = 'Role Leak'),
       (SELECT count(*) FROM rooms WHERE name LIKE 'Role Leak%'),
       (SELECT count(*) FROM terms WHERE name LIKE 'Role Leak%'),
       (SELECT count(*) FROM levels WHERE school_id = $1 AND code NOT LIKE 'E2E-%'),
       (SELECT md5(string_agg(l::text, '|' ORDER BY l.id)) FROM lessons l WHERE term_id = $2
          AND l.group_id::text LIKE '________-____-5%'),
       (SELECT count(*) FROM absence_reports WHERE lesson_id = $3),
       (SELECT md5(string_agg(c::text, '|' ORDER BY c.id)) FROM makeup_credits c WHERE student_id = $4)
     )::text AS row`,
    [ids.school, ids.term, ids.lesson, ids.student],
  );
  rows.counts = counts.row;
  return rows;
}

test.describe("role boundaries › admin area", () => {
  test("the cases cover every admin server action", () => {
    const covered = new Set(
      allAdminCases(placeholderIds()).map(({ action }) => action.join("#")),
    );
    const admin = [...compiledServerActions().keys()].filter((key) =>
      key.startsWith("src/app/admin/"),
    );
    expect(admin.length).toBeGreaterThan(0);
    expect(admin.filter((key) => !covered.has(key))).toEqual([]);
  });

  for (const role of ["teacher", "student"] as const) {
    test(`a ${role} gets 403 on every admin page`, async ({ browser }) => {
      const page = await signedIn(browser, LOGINS.A[role], role);
      for (const path of adminPages(a)) {
        const response = await serverResponse(page, path);
        expectForbidden(response, path);
        expectNoneOf(response.body, ["A1 Morning", "Room 1 (London)"], path);
      }
    });

    test(`a ${role} can't run any admin server action`, async ({ browser }) => {
      const page = await signedIn(browser, LOGINS.A[role], role);
      const before = await snapshot(a);
      for (const c of allAdminCases(a)) {
        const { status, result } = await callAction(page, c.action, c.args);
        expect(result, c.name).toBeNull();
        expect(status, c.name).not.toBe(200);
      }
      expect(await snapshot(a)).toEqual(before);
    });
  }

  test("teachers and students can't open each other's areas", async ({
    browser,
  }) => {
    const teacher = await signedIn(browser, LOGINS.A.teacher, "teacher");
    for (const path of [
      "/student",
      `/student/timetable?week=${WEEK}`,
      "/student/notifications",
      "/student/calendar",
      "/student/ratings",
      `/student/ratings/${a.teacher}`,
    ]) {
      expectForbidden(await serverResponse(teacher, path), path);
    }
    const student = await signedIn(browser, LOGINS.A.student, "student");
    for (const path of [
      "/teacher",
      `/teacher/timetable?week=${WEEK}`,
      "/teacher/notifications",
      "/teacher/calendar",
      "/teacher/substitutions",
    ]) {
      expectForbidden(await serverResponse(student, path), path);
    }
  });
});

test.describe("role boundaries › demoted admin with a live session", () => {
  // The session token still says ADMIN, so the proxy lets requests through:
  // this proves the pages and actions themselves check the role in the DB.
  const userId = randomUUID();
  const email = `demoted.admin.${userId}@example.test`;

  test.beforeAll(async () => {
    await sql(
      `INSERT INTO users (id, email, name, password_hash, updated_at)
       VALUES ($1, $2, 'Demoted Admin', $3, now())`,
      [userId, email, await hashPassword(DEMO_PASSWORD)],
    );
    await sql(
      `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
       VALUES ($1, $2, $3, 'ADMIN', now())`,
      [randomUUID(), a.school, userId],
    );
  });

  test.afterAll(async () => {
    await sql("DELETE FROM memberships WHERE user_id = $1", [userId]);
    await sql("DELETE FROM users WHERE id = $1", [userId]);
  });

  for (const role of ["TEACHER", "STUDENT"] as const) {
    test(`demoted to ${role.toLowerCase()}: admin pages and actions refuse`, async ({
      page,
    }) => {
      await sql("UPDATE memberships SET role = 'ADMIN' WHERE user_id = $1", [
        userId,
      ]);
      await signIn(page, email);
      await page.waitForURL("/admin");
      await sql("UPDATE memberships SET role = $2 WHERE user_id = $1", [
        userId,
        role,
      ]);

      for (const path of adminPages(a)) {
        await page.goto(path);
        await expect(
          page.getByRole("heading", { name: FORBIDDEN }),
          path,
        ).toBeVisible();
      }

      const before = await snapshot(a);
      for (const c of allAdminCases(a)) {
        const { result } = await callAction(page, c.action, c.args);
        expect(result?.ok, c.name).not.toBe(true);
      }
      expect(await snapshot(a)).toEqual(before);
    });
  }
});

test.describe("role boundaries › timetables", () => {
  /** Group names with a lesson in WEEK, split by `isOwn(lesson)`. */
  async function groupsInWeek(isOwnSql: string, param: string) {
    const rows = await sql<{ name: string; own: boolean }>(
      `SELECT g.name, bool_or(${isOwnSql}) AS own
       FROM lessons l JOIN groups g ON g.id = l.group_id
       WHERE l.school_id = $1 AND l.starts_at >= $2::date AND l.starts_at < $2::date + 7
       GROUP BY g.name`,
      [a.school, WEEK, param],
    );
    return {
      own: rows.filter((r) => r.own).map((r) => r.name),
      others: rows.filter((r) => !r.own).map((r) => r.name),
    };
  }

  test("a student sees only their own groups' lessons", async ({ browser }) => {
    const { own, others } = await groupsInWeek(
      `EXISTS (SELECT 1 FROM group_memberships m WHERE m.group_id = l.group_id
               AND m.student_id = $3 AND m.joined_at <= l.starts_at
               AND (m.left_at IS NULL OR m.left_at > l.starts_at))`,
      a.student,
    );
    expect(own.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    // Classmates' names stay with teachers and admins.
    const classmates = await sql<{ name: string }>(
      `SELECT DISTINCT u.name FROM group_memberships m
       JOIN student_profiles s ON s.id = m.student_id JOIN users u ON u.id = s.user_id
       WHERE m.group_id IN (SELECT group_id FROM group_memberships WHERE student_id = $1)
         AND m.student_id <> $1`,
      [a.student],
    );

    const page = await signedIn(browser, LOGINS.A.student, "student");
    // Admin-only filters must be ignored for students.
    const filters = `teacher=${a.teacher}&group=${await otherGroup(a.student)}`;
    for (const path of [
      `/student/timetable?week=${WEEK}`,
      `/student/timetable?week=${WEEK}&view=day`,
      `/student/timetable?week=${WEEK}&${filters}`,
    ]) {
      const { body } = await serverResponse(page, path);
      for (const name of own) expect(body, path).toContain(name);
      expectNoneOf(body, others, path);
      expectNoneOf(
        body,
        classmates.map((c) => c.name),
        path,
      );
    }
  });

  test("a teacher sees only the lessons they teach", async ({ browser }) => {
    const { own, others } = await groupsInWeek(
      "(l.teacher_id = $3 OR l.substitute_teacher_id = $3)",
      a.teacher,
    );
    expect(own.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    const [colleague] = await sql<{ id: string }>(
      "SELECT id FROM teacher_profiles WHERE school_id = $1 AND id <> $2 LIMIT 1",
      [a.school, a.teacher],
    );

    const page = await signedIn(browser, LOGINS.A.teacher, "teacher");
    for (const path of [
      `/teacher/timetable?week=${WEEK}`,
      `/teacher/timetable?week=${WEEK}&teacher=${colleague.id}`,
    ]) {
      const { body } = await serverResponse(page, path);
      for (const name of own) expect(body, path).toContain(name);
      expectNoneOf(body, others, path);
    }
  });
});

/** A group in school A the student is not a member of. */
async function otherGroup(studentId: string) {
  const [group] = await sql<{ id: string }>(
    `SELECT id FROM groups WHERE school_id = $1 AND id NOT IN
       (SELECT group_id FROM group_memberships WHERE student_id = $2) LIMIT 1`,
    [a.school, studentId],
  );
  return group.id;
}

/** Ids for building the case list without a database (coverage check). */
function placeholderIds(): SchoolIds {
  return new Proxy({} as SchoolIds, { get: () => randomUUID() });
}
