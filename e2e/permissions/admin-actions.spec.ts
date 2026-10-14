import {
  type APIRequestContext,
  type Browser,
  expect,
  type Page,
  test,
} from "@playwright/test";

import { hashPassword } from "../../src/server/auth/password";
import { DEMO_LOGINS, DEMO_PASSWORD, signIn, sql } from "../helpers";
import {
  actionResult,
  callServerAction,
  compiledServerActions,
  FormFields,
  pagesIn,
  PLACEHOLDER_ID,
  type ServerAction,
  serverActionsIn,
} from "../server-actions";

/**
 * Permission-leak tests for the admin server actions: callers who must not
 * use them post the action requests directly — no UI involved — and the
 * database must not change. Three ways in:
 *
 * - a real teacher / student session: refused before the action runs (the
 *   proxy answers 403 for /admin, and Next can't forward the call there);
 * - a session issued to an admin who has since been made a teacher or a
 *   student: the token still says ADMIN, so the proxy lets it through and
 *   only the action's own database check (`runAdminAction`) stands in the
 *   way — that check must answer 403;
 * - an admin of another school passing this school's ids: not found.
 */

// Fixed ids so reruns converge; everything is removed again in afterAll.
const ID = (n: number) =>
  `00000000-0000-4000-8000-0000000c28${String(n).padStart(2, "0")}`;
const OTHER_SCHOOL = ID(1);
const OTHER_ADMIN = { id: ID(2), email: "admin@e2e-leak-school.test" };
const DEMOTED = {
  TEACHER: { id: ID(3), email: "e2e-demoted-teacher@demo-school.test" },
  STUDENT: { id: ID(4), email: "e2e-demoted-student@demo-school.test" },
} as const;
/** Targets in the demo school. */
const STUDENT = { user: ID(10), profile: ID(11) };
const ARCHIVED_STUDENT = { user: ID(12), profile: ID(13) };
const NEW_MEMBER = { user: ID(14), profile: ID(15) };
const ROOM = ID(20);
const ARCHIVED_ROOM = ID(21);
const LEVEL = ID(22);
const GROUP = ID(23);
const GROUP_MEMBERSHIP = ID(24);
const NEW_ADMIN_EMAIL = "e2e-leaked-admin@demo-school.test";
const FIXTURE_USERS = [
  OTHER_ADMIN.id,
  DEMOTED.TEACHER.id,
  DEMOTED.STUDENT.id,
  STUDENT.user,
  ARCHIVED_STUDENT.user,
  NEW_MEMBER.user,
];

type Attack = {
  action: string;
  file: string;
  /** Arguments that would change the targets if the call were allowed. */
  args: unknown[];
  /** Whether an admin of another school can name a target here. */
  crossSchool?: false;
};

const PEOPLE = "src/app/admin/_people/actions.ts";
const ROOMS = "src/app/admin/settings/rooms/actions.ts";
const LEVELS = "src/app/admin/levels/actions.ts";
const GROUPS = "src/app/admin/groups/actions.ts";
const ADMINS = "src/app/admin/settings/admins/actions.ts";

const ATTACKS: Attack[] = [
  {
    action: "setPasswordAction",
    file: PEOPLE,
    args: [STUDENT.user, null, new FormFields({ password: "Leaked-pass-123" })],
  },
  { action: "archivePersonAction", file: PEOPLE, args: [STUDENT.user] },
  {
    action: "restorePersonAction",
    file: PEOPLE,
    args: [ARCHIVED_STUDENT.user],
  },
  {
    action: "saveRoomAction",
    file: ROOMS,
    args: [
      ROOM,
      null,
      new FormFields({ name: "Leaked room", kind: "PHYSICAL", capacity: "99" }),
    ],
  },
  { action: "archiveRoomAction", file: ROOMS, args: [ROOM] },
  { action: "restoreRoomAction", file: ROOMS, args: [ARCHIVED_ROOM] },
  { action: "deleteRoomAction", file: ROOMS, args: [ROOM] },
  { action: "archiveLevelAction", file: LEVELS, args: [LEVEL] },
  { action: "archiveGroupAction", file: GROUPS, args: [GROUP] },
  {
    action: "addMembersAction",
    file: GROUPS,
    args: [
      GROUP,
      null,
      new FormFields({
        studentIds: [NEW_MEMBER.profile],
        startDate: "2026-09-01",
      }),
    ],
  },
  {
    action: "addToGroupAction",
    file: GROUPS,
    args: [
      NEW_MEMBER.profile,
      null,
      new FormFields({ groupId: GROUP, startDate: "2026-09-01" }),
    ],
  },
  {
    action: "removeMemberAction",
    file: GROUPS,
    args: [GROUP_MEMBERSHIP, null, new FormFields({ date: "2026-09-02" })],
  },
  {
    action: "createAdminAction",
    file: ADMINS,
    args: [
      null,
      new FormFields({
        name: "Leaked Admin",
        email: NEW_ADMIN_EMAIL,
        password: "Leaked-pass-123",
      }),
    ],
    // Creating an admin in one's own school is allowed; nothing to name.
    crossSchool: false,
  },
];

/** Everything the attacks could change, as one comparable value. */
async function snapshot() {
  const ids = [
    ...FIXTURE_USERS,
    STUDENT.profile,
    ARCHIVED_STUDENT.profile,
    NEW_MEMBER.profile,
    ROOM,
    ARCHIVED_ROOM,
    LEVEL,
    GROUP,
    GROUP_MEMBERSHIP,
  ];
  const [users, memberships, rooms, levels, groups, groupMembers, audit] =
    await Promise.all([
      sql(
        `SELECT * FROM users WHERE id = ANY($1::uuid[]) OR email = $2 ORDER BY id`,
        [FIXTURE_USERS, NEW_ADMIN_EMAIL],
      ),
      sql(
        `SELECT m.* FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.user_id = ANY($1::uuid[]) OR u.email = $2 ORDER BY m.id`,
        [FIXTURE_USERS, NEW_ADMIN_EMAIL],
      ),
      sql(`SELECT * FROM rooms WHERE id = ANY($1::uuid[]) ORDER BY id`, [
        [ROOM, ARCHIVED_ROOM],
      ]),
      sql(`SELECT * FROM levels WHERE id = $1`, [LEVEL]),
      sql(`SELECT * FROM groups WHERE id = $1`, [GROUP]),
      sql(
        `SELECT * FROM group_memberships
         WHERE group_id = $1 OR student_id = $2 ORDER BY id`,
        [GROUP, NEW_MEMBER.profile],
      ),
      sql(`SELECT * FROM audit_logs WHERE entity_id = ANY($1::uuid[])`, [ids]),
    ]);
  return { users, memberships, rooms, levels, groups, groupMembers, audit };
}

async function removeFixtures() {
  const users = [...FIXTURE_USERS];
  await sql(
    `DELETE FROM group_memberships WHERE group_id = $1 OR student_id = $2`,
    [GROUP, NEW_MEMBER.profile],
  );
  await sql(`DELETE FROM groups WHERE id = $1`, [GROUP]);
  await sql(`DELETE FROM levels WHERE id = $1`, [LEVEL]);
  await sql(`DELETE FROM rooms WHERE id = ANY($1::uuid[])`, [
    [ROOM, ARCHIVED_ROOM],
  ]);
  await sql(`DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])`, [
    users,
  ]);
  // A leaked admin (only if a test failed) goes too.
  await sql(
    `DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email = $1)`,
    [NEW_ADMIN_EMAIL],
  );
  await sql(`DELETE FROM users WHERE email = $1`, [NEW_ADMIN_EMAIL]);
  await sql(`DELETE FROM student_profiles WHERE user_id = ANY($1::uuid[])`, [
    users,
  ]);
  await sql(`DELETE FROM memberships WHERE user_id = ANY($1::uuid[])`, [users]);
  await sql(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
  await sql(`DELETE FROM schools WHERE id = $1`, [OTHER_SCHOOL]);
}

async function createFixtures() {
  const [{ id: school }] = await sql<{ id: string }>(
    `SELECT id FROM schools WHERE slug = 'demo-language-school'`,
  );
  const hash = await hashPassword(DEMO_PASSWORD);
  await sql(
    `INSERT INTO schools (id, name, slug, updated_at)
     VALUES ($1, 'E2E Leak School', 'e2e-leak-school', now())`,
    [OTHER_SCHOOL],
  );
  const person = async (
    id: string,
    email: string,
    schoolId: string,
    role: string,
    {
      archived = false,
      profile,
    }: { archived?: boolean; profile?: string } = {},
  ) => {
    await sql(
      `INSERT INTO users (id, email, name, password_hash, deleted_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [
        id,
        email,
        `E2E ${email.split("@")[0]}`,
        hash,
        archived ? new Date() : null,
      ],
    );
    await sql(
      `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now())`,
      [schoolId, id, role],
    );
    if (profile) {
      await sql(
        `INSERT INTO student_profiles (id, school_id, user_id, updated_at)
         VALUES ($1, $2, $3, now())`,
        [profile, schoolId, id],
      );
    }
  };
  await person(OTHER_ADMIN.id, OTHER_ADMIN.email, OTHER_SCHOOL, "ADMIN");
  for (const { id, email } of Object.values(DEMOTED)) {
    await person(id, email, school, "ADMIN");
  }
  await person(
    STUDENT.user,
    "e2e-leak-student@demo-school.test",
    school,
    "STUDENT",
    {
      profile: STUDENT.profile,
    },
  );
  await person(
    ARCHIVED_STUDENT.user,
    "e2e-leak-archived@demo-school.test",
    school,
    "STUDENT",
    { archived: true, profile: ARCHIVED_STUDENT.profile },
  );
  await person(
    NEW_MEMBER.user,
    "e2e-leak-new-member@demo-school.test",
    school,
    "STUDENT",
    {
      profile: NEW_MEMBER.profile,
    },
  );
  await sql(
    `INSERT INTO rooms (id, school_id, name, kind, capacity, archived_at, updated_at)
     VALUES ($1, $3, 'E2E Leak Room', 'PHYSICAL', 10, NULL, now()),
            ($2, $3, 'E2E Leak Archived Room', 'PHYSICAL', 10, now(), now())`,
    [ROOM, ARCHIVED_ROOM, school],
  );
  await sql(
    `INSERT INTO levels (id, school_id, code, name, rank, updated_at)
     VALUES ($1, $2, 'E2E-LEAK', 'E2E Leak Level', 9000, now())`,
    [LEVEL, school],
  );
  await sql(
    `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at)
     VALUES ($1, $2, $3, 'GROUP', 'E2E Leak Group', 10, now())`,
    [GROUP, school, LEVEL],
  );
  await sql(
    `INSERT INTO group_memberships (id, school_id, group_id, student_id, joined_at, updated_at)
     VALUES ($1, $2, $3, $4, '2026-09-01', now())`,
    [GROUP_MEMBERSHIP, school, GROUP, STUDENT.profile],
  );
}

/** Compiled admin actions by `filename#exportedName`. */
let actions: Map<string, ServerAction>;

async function newSession(browser: Browser, email: string, home: string) {
  const page = await browser.newPage();
  await signIn(page, email);
  await page.waitForURL(home);
  return page;
}

function action(key: string) {
  const found = actions.get(key);
  if (!found) throw new Error(`Server action ${key} is not compiled`);
  return found;
}

const call = (request: APIRequestContext, attack: Attack, path?: string) => {
  const { id, path: home } = action(`${attack.file}#${attack.action}`);
  return callServerAction(request, {
    id,
    path: path ?? home,
    args: attack.args,
  });
};

test.describe("permission leaks › admin server actions", () => {
  // One worker: the fixtures (and the demoted roles) are shared.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    await removeFixtures();
    await createFixtures();

    // In dev every route compiles on first request; render each admin page
    // once so all admin actions are in the manifest (a no-op on a build).
    const admin = await newSession(browser, DEMO_LOGINS.admin, "/admin");
    for (const path of pagesIn("src/app/admin")) await admin.request.get(path);
    await admin.close();

    actions = new Map(
      [...compiledServerActions()].filter(([key]) =>
        key.startsWith("src/app/admin/"),
      ),
    );
  });

  test.afterAll(async () => {
    await removeFixtures();
  });

  test("an admin of another school gets not found and changes nothing", async ({
    browser,
  }) => {
    // Also proves the ids and argument encoding reach the actions: a wrong
    // id would answer 409, not the action's own "not found".
    const page = await newSession(browser, OTHER_ADMIN.email, "/admin");
    const before = await snapshot();
    for (const attack of ATTACKS.filter((a) => a.crossSchool !== false)) {
      const response = await call(page.request, attack);
      expect(response.status(), attack.action).toBe(200);
      expect(actionResult(await response.text()), attack.action).toEqual({
        ok: false,
        formError: { key: "common.error.notFound" },
      });
    }
    expect(await snapshot()).toEqual(before);
    await page.close();
  });

  for (const [role, home] of [
    ["teacher", "/teacher"],
    ["student", "/student"],
  ] as const) {
    test(`a ${role} can't call admin actions`, async ({ browser }) => {
      const page = await newSession(browser, DEMO_LOGINS[role], home);
      const before = await snapshot();
      // Posted to the admin page that owns the action, and to the caller's
      // own area (Next then forwards the call to the owning page).
      for (const attack of ATTACKS) {
        for (const path of [undefined, home]) {
          const response = await call(page.request, attack, path);
          const body = await response.text();
          expect(
            response.status(),
            `${attack.action} ${path}`,
          ).toBeGreaterThanOrEqual(400);
          expect(actionResult(body), attack.action).toBeUndefined();
        }
      }
      expect(await snapshot()).toEqual(before);
      await page.close();
    });
  }

  for (const role of ["TEACHER", "STUDENT"] as const) {
    test.describe(`an admin demoted to ${role.toLowerCase()}`, () => {
      let page: Page;

      test.beforeEach(async ({ browser }) => {
        // Signed in as an admin, then demoted: the token still says ADMIN.
        page = await newSession(browser, DEMOTED[role].email, "/admin");
        await sql(`UPDATE memberships SET role = $2 WHERE user_id = $1`, [
          DEMOTED[role].id,
          role,
        ]);
      });

      test.afterEach(async () => {
        await sql(`UPDATE memberships SET role = 'ADMIN' WHERE user_id = $1`, [
          DEMOTED[role].id,
        ]);
        await page.close();
      });

      test("is refused by the actions themselves", async () => {
        const before = await snapshot();
        for (const attack of ATTACKS) {
          const response = await call(page.request, attack);
          expect(response.status(), attack.action).toBe(403);
          expect(actionResult(await response.text())).toBeUndefined();
        }
        expect(await snapshot()).toEqual(before);
      });

      test("is refused by every admin action", async () => {
        // Arguments don't matter: the role is checked before anything else.
        const declared = serverActionsIn("src/app/admin");
        expect(declared.length).toBeGreaterThan(30);
        expect([...actions.keys()].sort()).toEqual(declared);
        for (const [key, { id, path }] of actions) {
          const response = await callServerAction(page.request, {
            id,
            path,
            args: [PLACEHOLDER_ID],
          });
          expect(response.status(), key).toBe(403);
        }
      });
    });
  }
});
