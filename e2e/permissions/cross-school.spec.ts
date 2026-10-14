import { expect, type Page, test } from "@playwright/test";

import { sql } from "../helpers";
import { crossSchoolCases } from "./action-cases";
import {
  expectNoneOf,
  LOGINS,
  SCHOOL_A,
  SCHOOL_B,
  SECOND_NAMES,
  schoolFingerprint,
  type SchoolIds,
  schoolIds,
  serverResponse,
  signedIn,
  WEEK,
} from "./fixtures";
import { callAction } from "../server-actions";

// Tenant isolation (CARM-26): nobody in school A can read or change school
// B's data — not through pages, not through server actions, not with guessed
// or harvested ids — and the other way round.

let a: SchoolIds;
let b: SchoolIds;

test.beforeAll(async () => {
  a = await schoolIds(SCHOOL_A);
  b = await schoolIds(SCHOOL_B);
});

/** Every id of a school's fixtures; none may appear in the other school. */
const idsOf = (ids: SchoolIds) => Object.values(ids);

/** Names unique to school A that would show up in any list or timetable. */
const SCHOOL_A_NAMES = [
  "Demo Language School",
  "Jana Nováková",
  "Adam Kollár",
  "A1 Morning",
  "Room 1 (London)",
  "General English A1",
];

const ADMIN_PAGES = [
  "/admin",
  "/admin/teachers",
  "/admin/teachers?status=archived",
  "/admin/students",
  "/admin/students?status=archived",
  "/admin/groups",
  "/admin/groups?tab=courses",
  "/admin/lessons",
  "/admin/lessons?filter=past",
  "/admin/lessons?filter=upcoming",
  "/admin/levels",
  "/admin/settings/admins",
  "/admin/settings/rooms",
  "/admin/settings/terms",
  "/admin/settings/school",
  "/admin/settings/absences",
  "/admin/absences",
  "/admin/absences?tab=review",
  "/admin/absences?tab=replacements",
  `/admin/timetable?week=${WEEK}`,
  `/admin/timetable/edit`,
];

async function expectPagesClean(page: Page, paths: string[], leaks: string[]) {
  for (const path of paths) {
    const { status, body } = await serverResponse(page, path);
    expect(status, path).toBe(200);
    expectNoneOf(body, leaks, path);
  }
}

/** Detail pages for another school's ids render "not found", nothing else. */
async function expectNotFound(page: Page, paths: string[], leaks: string[]) {
  for (const path of paths) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
      path,
    ).toBeVisible();
    expectNoneOf(await page.content(), leaks, path);
  }
}

test.describe("cross-school › pages", () => {
  test("an admin of school A sees nothing of school B", async ({ browser }) => {
    const page = await signedIn(browser, LOGINS.A.admin, "admin");
    const leaks = [...Object.values(SECOND_NAMES), ...idsOf(b)];
    await expectPagesClean(page, ADMIN_PAGES, leaks);

    // School B's ids as filters, list searches and editor terms.
    await expectPagesClean(
      page,
      [
        `/admin/timetable?week=${WEEK}&teacher=${b.teacher}&room=${b.room}&group=${b.group}`,
        `/admin/timetable?week=${WEEK}&teacher=${b.teacher}`,
        `/admin/timetable?week=${WEEK}&group=${b.group}`,
        `/admin/timetable/edit?term=${b.term}`,
        `/admin/students?group=${b.group}&level=${b.level}`,
        `/admin/students?q=Bianca`,
        `/admin/teachers?q=Bruno`,
        `/admin/groups?level=${b.level}&teacher=${b.teacher}`,
        `/admin/absences?student=${b.student}&group=${b.group}&teacher=${b.teacher}`,
        `/admin/absences?tab=replacements&student=${b.student}&group=${b.group}`,
      ],
      Object.values(SECOND_NAMES),
    );

    // Guessed ids: by profile id and by user id.
    await expectNotFound(
      page,
      [
        `/admin/teachers/${b.teacher}`,
        `/admin/teachers/${b.teacherUser}`,
        `/admin/students/${b.student}`,
        `/admin/students/${b.studentUser}`,
        `/admin/groups/${b.group}`,
        `/admin/lessons/${b.lesson}`,
      ],
      Object.values(SECOND_NAMES),
    );
  });

  test("an admin of school B sees nothing of school A", async ({ browser }) => {
    const page = await signedIn(browser, LOGINS.B.admin, "admin");
    // Positive control: school B's own data is there.
    const { body } = await serverResponse(page, "/admin/groups");
    expect(body).toContain(SECOND_NAMES.group);

    const leaks = [...SCHOOL_A_NAMES, ...idsOf(a)];
    await expectPagesClean(page, ADMIN_PAGES, leaks);
    await expectPagesClean(
      page,
      [
        `/admin/timetable?week=${WEEK}&teacher=${a.teacher}&room=${a.room}&group=${a.group}`,
        `/admin/timetable/edit?term=${a.term}`,
        `/admin/students?group=${a.group}`,
        `/admin/absences?student=${a.student}&group=${a.group}&teacher=${a.teacher}`,
        `/admin/absences?tab=replacements&student=${a.student}`,
      ],
      SCHOOL_A_NAMES,
    );
    await expectNotFound(
      page,
      [
        `/admin/teachers/${a.teacher}`,
        `/admin/teachers/${a.teacherUser}`,
        `/admin/students/${a.student}`,
        `/admin/students/${a.studentUser}`,
        `/admin/groups/${a.group}`,
        `/admin/lessons/${a.lesson}`,
      ],
      SCHOOL_A_NAMES,
    );
  });

  for (const role of ["teacher", "student"] as const) {
    test(`a ${role} of school A never sees school B's lessons`, async ({
      browser,
    }) => {
      const page = await signedIn(browser, LOGINS.A[role], role);
      await expectPagesClean(
        page,
        [`/${role}`, `/${role}/timetable?week=${WEEK}`],
        [...Object.values(SECOND_NAMES), ...idsOf(b)],
      );
      // School B's ids as filters (echoed in the URL, so check names only).
      const filters = `teacher=${b.teacher}&group=${b.group}&room=${b.room}`;
      await expectPagesClean(
        page,
        [
          `/${role}/timetable?week=${WEEK}&${filters}`,
          `/${role}/timetable?week=${WEEK}&view=day&${filters}`,
        ],
        Object.values(SECOND_NAMES),
      );
    });

    test(`a ${role} of school B sees their lessons, none of school A's`, async ({
      browser,
    }) => {
      const page = await signedIn(browser, LOGINS.B[role], role);
      const { body } = await serverResponse(
        page,
        `/${role}/timetable?week=${WEEK}`,
      );
      expect(body).toContain(SECOND_NAMES.group);
      expectNoneOf(body, [...SCHOOL_A_NAMES, ...idsOf(a)], "timetable");
    });
  }
});

test.describe("cross-school › server actions", () => {
  test.describe.configure({ mode: "serial" });

  test("an admin of school A can't change school B with B's ids", async ({
    browser,
  }) => {
    const page = await signedIn(browser, LOGINS.A.admin, "admin");
    const before = await schoolFingerprint(b.school);

    // Control: the same request shape works on the admin's own school, so a
    // refusal below is the server saying no — not a malformed call.
    const control = await callAction(
      page,
      ["src/app/admin/settings/rooms/actions.ts", "restoreRoomAction"],
      [a.room],
    );
    expect(control.result).toMatchObject({ ok: true });

    for (const c of crossSchoolCases(b, a)) {
      const { status, result } = await callAction(page, c.action, c.args);
      expect(status, c.name).toBe(200);
      expect(result?.ok, c.name).toBe(false);
      if (c.refusedOn) {
        expect(Object.keys(result?.fieldErrors ?? {}), c.name).toEqual([
          c.refusedOn,
        ]);
      } else {
        expect(result?.formError, c.name).toMatchObject({
          key: expect.stringMatching(
            /^(common\.error\.notFound|scheduling\.errors\.NOT_FOUND)$/,
          ),
        });
      }
    }

    expect(await schoolFingerprint(b.school)).toEqual(before);
  });

  test("an admin of school B can't change school A with A's ids", async ({
    browser,
  }) => {
    const page = await signedIn(browser, LOGINS.B.admin, "admin");
    // Other specs change school A in parallel, so compare only the rows
    // these calls target.
    const targets = await targetedRows(a);
    for (const c of crossSchoolCases(a, b)) {
      const { status, result } = await callAction(page, c.action, c.args);
      expect(status, c.name).toBe(200);
      expect(result?.ok, c.name).toBe(false);
    }
    expect(await targetedRows(a)).toEqual(targets);
  });
});

/** The rows of `ids` that the cross-school cases aim at, as text. */
async function targetedRows(ids: SchoolIds) {
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
  ];
  const rows: Record<string, string> = {};
  for (const [table, id] of tables) {
    const [row] = await sql<{ row: string }>(
      `SELECT t::text AS row FROM ${table} t WHERE id = $1`,
      [id],
    );
    rows[`${table}:${id}`] = row?.row ?? "missing";
  }
  // The seeded groups' lessons (deterministic v5 ids): specs running in
  // parallel add lessons of their own groups to the same term.
  const [lessons] = await sql<{ digest: string }>(
    `SELECT md5(string_agg(l::text, '|' ORDER BY l.id)) AS digest
     FROM lessons l WHERE term_id = $1 AND l.group_id::text LIKE '________-____-5%'`,
    [ids.term],
  );
  rows.lessons = lessons.digest;
  return rows;
}
