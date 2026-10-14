import { randomUUID } from "node:crypto";

import { type Browser, expect, type Page, test } from "@playwright/test";

import { hashPassword } from "../../src/server/auth/password";
import {
  addDays,
  isoWeekday,
  toZonedDateTime,
  zonedTimeToUtc,
} from "../../src/server/scheduling/time";
import { DEMO_PASSWORD, sql } from "../helpers";
import {
  type ActionResponse,
  callAction,
  serverActionsIn,
} from "../server-actions";
import {
  expectNoneOf,
  isNotFound,
  LOGINS,
  type Role,
  SCHOOL_B,
  schoolFingerprint,
  type SchoolIds,
  schoolIds,
  SECOND_NAMES,
  serverResponse,
  signedIn,
} from "./fixtures";

// Phase 4 permissions (CARM-57): group lesson times, teachers' levels and
// weekly maximum, and the "Assign teachers" draft (generate, edit, check,
// publish) belong to the admins of the school. Teachers, students and the
// admins of another school are refused in the UI and on the server, and a
// draft changes nothing live until it is published.
//
// The generator reads every group and teacher of a school, so this spec
// runs in a school of its own ("C"), created and removed here: a draft of
// the demo school would pick up the groups and teachers other specs create
// in parallel, and applying it would pin their rows with slots. School B
// (the seeded second school) is the other tenant.
//
// - Tilda (teacher) teaches "group" on Mondays 10:00–11:00 in the term's
//   four weeks; Colm (colleague) teaches the same level but nothing yet.
//   Stella (student) is in "group".
// - The admin generates a REPLAN_FROM draft and moves "group" to Colm by
//   hand. Until it is published, every live row stays as it was and only
//   Tilda's and Stella's timetables show the group.

const GROUPS = "src/app/admin/groups/actions.ts";
const TEACHERS = "src/app/admin/teachers/actions.ts";
const GENERATOR = "src/app/admin/timetable/generator-actions.ts";
const TZ = "Europe/Bratislava";
const FORBIDDEN = "You don't have access to this page";

const suffix = randomUUID().slice(0, 8);
const NAMES = {
  school: `E2E Phase4 School ${suffix}`,
  admin: `Ada Phase4 ${suffix}`,
  teacher: `Tilda Phase4 ${suffix}`,
  colleague: `Colm Phase4 ${suffix}`,
  student: `Stella Phase4 ${suffix}`,
  level: `P4 Level ${suffix}`,
  room: `P4 Room ${suffix}`,
  group: `P4 Group ${suffix}`,
  spare: `P4 Spare ${suffix}`,
  term: `P4 Term ${suffix}`,
};
type Who = "admin" | "teacher" | "colleague" | "student";
const WHO: Record<Who, Role> = {
  admin: "admin",
  teacher: "teacher",
  colleague: "teacher",
  student: "student",
};
const emailOf = (who: Who) => `e2e-p4-${who}-${suffix}@phase4.test`;

const today = toZonedDateTime(new Date(), TZ).date;
/** The term: four weeks from the first Monday at least two weeks away. */
let termStart = addDays(today, 14);
while (isoWeekday(termStart) !== 1) termStart = addDays(termStart, 1);
const termEnd = addDays(termStart, 27);
const MONDAYS = [0, 7, 14, 21].map((d) => addDays(termStart, d));

const ids = {
  school: randomUUID(),
  users: {
    admin: randomUUID(),
    teacher: randomUUID(),
    colleague: randomUUID(),
    student: randomUUID(),
  } as Record<Who, string>,
  teacher: randomUUID(),
  colleague: randomUUID(),
  student: randomUUID(),
  level: randomUUID(),
  room: randomUUID(),
  group: randomUUID(),
  spare: randomUUID(),
  term: randomUUID(),
  slot: randomUUID(),
  /** The draft and its run, once the admin generated them. */
  draft: "",
  run: "",
};

/** The ids an attacker would aim at in a school. */
type Target = {
  term: string;
  draft: string;
  run: string;
  group: string;
  teacher: string;
  level: string;
  room: string;
};

type Case = {
  name: string;
  action: readonly [string, string];
  args: unknown[];
};

/** Every Phase 4 admin action, aimed at `target`, with valid input. */
function phase4Cases(target: Target, version = 0): Case[] {
  const call = (action: string, ...args: unknown[]): Case => ({
    name: `generator: ${action}`,
    action: [GENERATOR, action],
    args,
  });
  return [
    {
      name: "set a group's lesson times",
      action: [GROUPS, "saveLessonTimesAction"],
      args: [
        target.group,
        {
          times: [
            {
              weekday: 3,
              startMinute: 900,
              endMinute: 990,
              roomId: target.room,
            },
          ],
        },
      ],
    },
    {
      name: "set a teacher's levels and maximum hours",
      action: [TEACHERS, "saveTeacherLevelsAction"],
      args: [target.teacher, { levelIds: [target.level], maxHours: 2 }],
    },
    call("checkReadinessAction", { termId: target.term }),
    call("setGroupSkippedAction", {
      termId: target.term,
      groupId: target.group,
      skipped: true,
    }),
    call("startRunAction", {
      termId: target.term,
      mode: "REPLAN_FROM",
      effectiveFrom: termStart,
    }),
    call("getRunAction", target.run),
    call("cancelRunAction", target.run),
    call("getDraftAction", target.term),
    call("teacherOptionsAction", {
      draftId: target.draft,
      groupId: target.group,
    }),
    call("saveAssignmentAction", {
      draftId: target.draft,
      version,
      groupId: target.group,
      teacherId: target.teacher,
    }),
    call("setAssignmentsLockedAction", {
      draftId: target.draft,
      version,
      groupIds: [target.group],
      locked: false,
    }),
    call("checkDraftAction", target.draft),
    call("previewApplyAction", { draftId: target.draft, publish: false }),
    call("applyDraftAction", {
      draftId: target.draft,
      version,
      acknowledgedConflictKeys: [],
      publish: false,
    }),
    call("discardDraftAction", target.draft),
  ];
}

const schoolC = (): Target => ({
  term: ids.term,
  draft: ids.draft,
  run: ids.run,
  group: ids.group,
  teacher: ids.teacher,
  level: ids.level,
  room: ids.room,
});

/** School B has no draft or run: its term's id stands in for both. */
const schoolB = (b: SchoolIds): Target => ({
  term: b.term,
  draft: b.term,
  run: b.term,
  group: b.group,
  teacher: b.teacher,
  level: b.level,
  room: b.room,
});

/** School C's Phase 4 admin pages. */
const phase4Pages = () => [
  `/admin/timetable/generate?term=${ids.term}`,
  `/admin/timetable/generate?term=${ids.term}&tab=draft`,
  "/admin/groups",
  `/admin/groups/${ids.group}`,
  "/admin/teachers",
  `/admin/teachers/${ids.teacher}`,
];

/** School C's names, none of which may reach another tenant or role. */
const C_SECRETS = () => [
  NAMES.school,
  NAMES.teacher,
  NAMES.colleague,
  NAMES.student,
  NAMES.group,
  NAMES.spare,
  NAMES.room,
  NAMES.term,
  NAMES.level,
];

/** Draft, run and audit rows: what generating and editing a draft writes. */
const DRAFT_TABLES = [
  "timetable_drafts",
  "timetable_draft_assignments",
  "generator_runs",
  "audit_logs",
];

/** School C's live data: everything but the draft (see `DRAFT_TABLES`). */
async function liveData() {
  return liveDataOf(await schoolFingerprint(ids.school));
}

function liveDataOf(fingerprint: Record<string, string>) {
  const live = { ...fingerprint };
  for (const table of DRAFT_TABLES) delete live[table];
  return live;
}

/** School B's Phase 4 data and the rows the cases aim at, as text. */
async function schoolBRows(b: SchoolIds) {
  const [row] = await sql<{ row: string }>(
    `SELECT row(
       (SELECT string_agg(t::text, '|' ORDER BY t.id) FROM group_lesson_times t WHERE school_id = $1),
       (SELECT string_agg(t::text, '|' ORDER BY t.id) FROM teacher_levels t WHERE school_id = $1),
       (SELECT string_agg(t::text, '|' ORDER BY t.id) FROM group_term_skips t WHERE school_id = $1),
       (SELECT string_agg(t::text, '|' ORDER BY t.id) FROM timetable_drafts t WHERE school_id = $1),
       (SELECT string_agg(t::text, '|' ORDER BY t.id) FROM generator_runs t WHERE school_id = $1),
       (SELECT string_agg(t::text, '|' ORDER BY t.id) FROM timetable_slots t WHERE school_id = $1),
       (SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) FROM lessons t WHERE school_id = $1),
       (SELECT t::text FROM teacher_profiles t WHERE id = $2),
       (SELECT t::text FROM groups t WHERE id = $3),
       (SELECT t::text FROM terms t WHERE id = $4)
     )::text AS row`,
    [b.school, b.teacher, b.group, b.term],
  );
  return row.row;
}

/** Who teaches the group's live slots and lessons, by date. */
async function liveTeachers() {
  return sql<{ kind: string; date: string; teacher: string }>(
    `SELECT 'slot' AS kind, coalesce(to_char(valid_from, 'YYYY-MM-DD'), '-') AS date,
            teacher_id::text AS teacher
     FROM timetable_slots WHERE group_id = $1
     UNION ALL
     SELECT 'lesson', to_char(occurrence_date, 'YYYY-MM-DD'), teacher_id::text
     FROM lessons WHERE group_id = $1 AND status = 'SCHEDULED'
     ORDER BY 1, 2, 3`,
    [ids.group],
  );
}

/** Refused before the action ran: the role check answers, no `ActionResult`. */
function expectRoleRefusal(response: ActionResponse, name: string) {
  expect(response.result, name).toBeNull();
  expect(response.status, name).not.toBe(200);
}

/**
 * Refused by an admin of another school: the ids don't exist for them. A
 * read that answers "nothing here" (no draft for that term) is a refusal
 * too, as long as none of the other school's data comes back.
 */
function expectForeignRefusal(
  response: ActionResponse,
  name: string,
  secrets: string[],
) {
  expect(response.status, name).toBe(200);
  const { result } = response;
  expect(result, name).not.toBeNull();
  if (result!.ok) expect(result!.data ?? null, name).toBeNull();
  else expect(JSON.stringify(result), name).toMatch(/NOT_FOUND|notFound/);
  expectNoneOf(response.body, secrets, name);
}

/** Removes school C: rows that block others go first, then the school. */
async function removeSchoolC() {
  await sql(
    "UPDATE lessons SET rescheduled_from_id = NULL WHERE school_id = $1",
    [ids.school],
  );
  const tables = (
    await sql<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND column_name = 'school_id'`,
    )
  ).map((r) => r.table_name);
  // Restrict FKs between tenant tables: retry until every table is empty.
  for (let pass = 0; pass < 10; pass++) {
    let blocked = 0;
    for (const table of tables) {
      try {
        await sql(`DELETE FROM ${table} WHERE school_id = $1`, [ids.school]);
      } catch {
        blocked++;
      }
    }
    if (!blocked) break;
  }
  await sql("DELETE FROM schools WHERE id = $1", [ids.school]);
  await sql("DELETE FROM users WHERE id = ANY($1::uuid[])", [
    Object.values(ids.users),
  ]);
}

test.describe("phase 4 permissions", () => {
  test.describe.configure({ mode: "serial" });

  let browserRef: Browser;
  let b: SchoolIds;
  type Login = Who | "adminB";
  const pages = new Map<Login, Page>();
  /** A signed-in page for `who`, shared by the tests of this file. */
  const as = async (who: Login) => {
    if (!pages.has(who)) {
      pages.set(
        who,
        who === "adminB"
          ? await signedIn(browserRef, LOGINS.B.admin, "admin")
          : await signedIn(browserRef, emailOf(who), WHO[who]),
      );
    }
    return pages.get(who)!;
  };

  test.beforeAll(async ({ browser }) => {
    browserRef = browser;
    b = await schoolIds(SCHOOL_B);
    const school = ids.school;
    const hash = await hashPassword(DEMO_PASSWORD);

    await sql(
      `INSERT INTO schools (id, name, slug, timezone, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [school, NAMES.school, `e2e-phase4-${suffix}`, TZ],
    );
    const roles: Record<Who, string> = {
      admin: "ADMIN",
      teacher: "TEACHER",
      colleague: "TEACHER",
      student: "STUDENT",
    };
    for (const who of Object.keys(roles) as Who[]) {
      await sql(
        `INSERT INTO users (id, email, name, password_hash, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [ids.users[who], emailOf(who), NAMES[who], hash],
      );
      await sql(
        `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3::"Role", now())`,
        [school, ids.users[who], roles[who]],
      );
    }
    await sql(
      `INSERT INTO levels (id, school_id, code, name, rank, updated_at)
       VALUES ($1, $2, 'P4', $3, 1, now())`,
      [ids.level, school, NAMES.level],
    );
    await sql(
      `INSERT INTO rooms (id, school_id, name, kind, capacity, updated_at)
       VALUES ($1, $2, $3, 'PHYSICAL', 10, now())`,
      [ids.room, school, NAMES.room],
    );
    await sql(
      `INSERT INTO teacher_profiles (id, school_id, user_id, updated_at)
       VALUES ($1, $3, $4, now()), ($2, $3, $5, now())`,
      [
        ids.teacher,
        ids.colleague,
        school,
        ids.users.teacher,
        ids.users.colleague,
      ],
    );
    await sql(
      `INSERT INTO teacher_levels (id, school_id, teacher_id, level_id)
       VALUES (gen_random_uuid(), $1, $2, $4), (gen_random_uuid(), $1, $3, $4)`,
      [school, ids.teacher, ids.colleague, ids.level],
    );
    await sql(
      `INSERT INTO student_profiles (id, school_id, user_id, level_id, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [ids.student, school, ids.users.student, ids.level],
    );
    await sql(
      `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at)
       VALUES ($1, $3, $4, 'GROUP', $5, 8, now()), ($2, $3, $4, 'GROUP', $6, 8, now())`,
      [ids.group, ids.spare, school, ids.level, NAMES.group, NAMES.spare],
    );
    await sql(
      `INSERT INTO group_memberships (id, school_id, group_id, student_id, joined_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now() - interval '7 days', now())`,
      [school, ids.group, ids.student],
    );
    // Both groups meet on Mondays; only "group" has a teacher.
    await sql(
      `INSERT INTO group_lesson_times (id, school_id, group_id, weekday, start_minute, end_minute, room_id, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 1, 600, 660, $4, now()),
              (gen_random_uuid(), $1, $3, 1, 720, 780, $4, now())`,
      [school, ids.group, ids.spare, ids.room],
    );
    await sql(
      `INSERT INTO terms (id, school_id, name, start_date, end_date, timetable_published_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())`,
      [ids.term, school, NAMES.term, termStart, termEnd],
    );
    await sql(
      `INSERT INTO timetable_slots (id, school_id, term_id, group_id, teacher_id, room_id, weekday, start_minute, end_minute, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 600, 660, now())`,
      [ids.slot, school, ids.term, ids.group, ids.teacher, ids.room],
    );
    for (const date of MONDAYS) {
      await sql(
        `INSERT INTO lessons (id, school_id, term_id, timetable_slot_id, group_id, teacher_id, room_id, occurrence_date, starts_at, ends_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
        [
          school,
          ids.term,
          ids.slot,
          ids.group,
          ids.teacher,
          ids.room,
          date,
          zonedTimeToUtc(date, 600, TZ),
          zonedTimeToUtc(date, 660, TZ),
        ],
      );
    }

    // In dev, actions compile with the pages that use them.
    const admin = await as("admin");
    for (const path of phase4Pages()) await admin.goto(path);
  });

  test.afterAll(async () => {
    for (const page of pages.values()) await page.context().close();
    await removeSchoolC();
  });

  test("the cases cover every Phase 4 admin action", () => {
    const covered = phase4Cases(schoolC()).map((c) => c.action.join("#"));
    const generator = serverActionsIn("src/app/admin/timetable").filter((key) =>
      key.startsWith(`${GENERATOR}#`),
    );
    expect(generator.length).toBeGreaterThan(10);
    expect(covered.sort()).toEqual(
      [
        ...generator,
        `${GROUPS}#saveLessonTimesAction`,
        `${TEACHERS}#saveTeacherLevelsAction`,
      ].sort(),
    );
  });

  test("a draft changes nothing live until it is published", async () => {
    test.setTimeout(120_000);
    const admin = await as("admin");
    const live = await liveData();
    const teachersBefore = await liveTeachers();
    expect(teachersBefore.map((r) => r.teacher)).toEqual(
      Array(MONDAYS.length + 1).fill(ids.teacher),
    );

    // Generate a draft that reconsiders every group from the term's start.
    const started = await callAction(
      admin,
      [GENERATOR, "startRunAction"],
      [{ termId: ids.term, mode: "REPLAN_FROM", effectiveFrom: termStart }],
    );
    expect(started.result, "startRunAction").toMatchObject({ ok: true });
    const run = started.result!.data as { runId: string; draftId: string };
    ids.run = run.runId;
    ids.draft = run.draftId;
    await expect
      .poll(
        async () => {
          const { result } = await callAction(
            admin,
            [GENERATOR, "getRunAction"],
            [ids.run],
          );
          return (result?.data as { status?: string } | undefined)?.status;
        },
        { timeout: 60_000 },
      )
      .toBe("DONE");
    expect(await liveData()).toEqual(live);

    // Move the group to Colm by hand and lock it.
    const draftOf = async () => {
      const { result } = await callAction(
        admin,
        [GENERATOR, "getDraftAction"],
        [ids.term],
      );
      return result!.data as {
        id: string;
        version: number;
        assignments: { groupId: string; teacherId: string | null }[];
      };
    };
    let draft = await draftOf();
    const saved = await callAction(
      admin,
      [GENERATOR, "saveAssignmentAction"],
      [
        {
          draftId: ids.draft,
          version: draft.version,
          groupId: ids.group,
          teacherId: ids.colleague,
        },
      ],
    );
    expect(saved.result, "saveAssignmentAction").toMatchObject({
      ok: true,
      data: { ok: true },
    });
    draft = await draftOf();
    expect(
      draft.assignments.find((x) => x.groupId === ids.group)?.teacherId,
    ).toBe(ids.colleague);
    for (const [action, args] of [
      ["checkDraftAction", [ids.draft]],
      ["previewApplyAction", [{ draftId: ids.draft, publish: false }]],
      ["teacherOptionsAction", [{ draftId: ids.draft, groupId: ids.group }]],
      ["checkReadinessAction", [{ termId: ids.term }]],
    ] as const) {
      const { result } = await callAction(
        admin,
        [GENERATOR, action],
        [...args],
      );
      expect(result, action).toMatchObject({ ok: true });
    }

    // Nothing live moved: slots, lessons and every other live row.
    expect(await liveData()).toEqual(live);
    expect(await liveTeachers()).toEqual(teachersBefore);

    // Teachers and students still see the live timetable, not the draft.
    const week = `?week=${termStart}`;
    const tilda = await serverResponse(
      await as("teacher"),
      `/teacher/timetable${week}`,
    );
    expect(tilda.body).toContain(NAMES.group);
    const colm = await serverResponse(
      await as("colleague"),
      `/teacher/timetable${week}`,
    );
    expectNoneOf(colm.body, [NAMES.group], "Colm's timetable before publish");
    const stella = await serverResponse(
      await as("student"),
      `/student/timetable${week}`,
    );
    expect(stella.body).toContain(NAMES.group);
    expectNoneOf(stella.body, [NAMES.colleague], "Stella's timetable");
  });

  for (const who of ["teacher", "student"] as const) {
    test(`a ${who} gets 403 on the Phase 4 admin pages`, async () => {
      const page = await as(who);
      for (const path of phase4Pages()) {
        const response = await serverResponse(page, path);
        expect(response.status, path).toBe(403);
        expectNoneOf(
          response.body,
          [NAMES.spare, NAMES.room, NAMES.term],
          path,
        );
        await page.goto(path);
        await expect(
          page.getByRole("heading", { name: FORBIDDEN }),
          path,
        ).toBeVisible();
      }
    });

    test(`a ${who} can't run any Phase 4 admin action`, async () => {
      const page = await as(who);
      const before = await schoolFingerprint(ids.school);
      for (const c of phase4Cases(schoolC())) {
        expectRoleRefusal(await callAction(page, c.action, c.args), c.name);
      }
      expect(await schoolFingerprint(ids.school)).toEqual(before);
    });
  }

  test("an admin of school B can't open or change school C's", async () => {
    const page = await as("adminB");
    for (const path of [
      `/admin/groups/${ids.group}`,
      `/admin/teachers/${ids.teacher}`,
    ]) {
      const { body } = await serverResponse(page, path);
      expect(isNotFound(body), path).toBe(true);
      expectNoneOf(body, C_SECRETS(), path);
    }
    // A foreign term in the URL falls back to the admin's own terms. (The
    // term's id is echoed with the URL, so the draft's id is the check.)
    for (const tab of ["", "&tab=draft"]) {
      const path = `/admin/timetable/generate?term=${ids.term}${tab}`;
      const { status, body } = await serverResponse(page, path);
      expect(status, path).toBe(200);
      expect(body, path).toContain(SECOND_NAMES.term);
      expectNoneOf(body, [...C_SECRETS(), ids.draft, ids.run], path);
    }

    const before = await schoolFingerprint(ids.school);
    const { version } = await draftRow();
    for (const c of phase4Cases(schoolC(), version)) {
      expectForeignRefusal(
        await callAction(page, c.action, c.args),
        c.name,
        C_SECRETS(),
      );
    }
    expect(await schoolFingerprint(ids.school)).toEqual(before);
  });

  test("an admin of school C can't change school B's, or use its rooms, levels, groups or teachers", async () => {
    const page = await as("admin");
    const bSecrets = [LOGINS.B.teacher, "Bruno Berger", "Northbridge Evening"];
    const bBefore = await schoolBRows(b);
    for (const c of phase4Cases(schoolB(b))) {
      expectForeignRefusal(
        await callAction(page, c.action, c.args),
        c.name,
        bSecrets,
      );
    }

    // School C's own records, with one of school B's ids as the choice.
    const cBefore = await schoolFingerprint(ids.school);
    const { version } = await draftRow();
    const choices: Case[] = [
      {
        name: "lesson times in school B's room",
        action: [GROUPS, "saveLessonTimesAction"],
        args: [
          ids.group,
          {
            times: [
              { weekday: 1, startMinute: 600, endMinute: 660, roomId: b.room },
            ],
          },
        ],
      },
      {
        name: "teach school B's level",
        action: [TEACHERS, "saveTeacherLevelsAction"],
        args: [ids.teacher, { levelIds: [b.level], maxHours: null }],
      },
      {
        name: "skip school B's group",
        action: [GENERATOR, "setGroupSkippedAction"],
        args: [{ termId: ids.term, groupId: b.group, skipped: true }],
      },
      {
        name: "options for school B's group",
        action: [GENERATOR, "teacherOptionsAction"],
        args: [{ draftId: ids.draft, groupId: b.group }],
      },
      {
        name: "assign school B's teacher",
        action: [GENERATOR, "saveAssignmentAction"],
        args: [
          {
            draftId: ids.draft,
            version,
            groupId: ids.group,
            teacherId: b.teacher,
          },
        ],
      },
      {
        name: "assign school B's group",
        action: [GENERATOR, "saveAssignmentAction"],
        args: [
          {
            draftId: ids.draft,
            version,
            groupId: b.group,
            teacherId: ids.teacher,
          },
        ],
      },
    ];
    for (const c of choices) {
      const response = await callAction(page, c.action, c.args);
      expect(response.status, c.name).toBe(200);
      const ok =
        response.result?.ok === true &&
        (response.result.data as { ok?: boolean } | undefined)?.ok !== false;
      expect(ok, `${c.name}: ${JSON.stringify(response.result)}`).toBe(false);
      expectNoneOf(response.body, bSecrets, c.name);
    }
    expect(await schoolFingerprint(ids.school)).toEqual(cBefore);

    // Locking only touches rows of the admin's own draft: a foreign group
    // matches none, so nothing is locked (the draft's version may move).
    const assignments = () =>
      sql<{ row: string }>(
        `SELECT t::text AS row FROM timetable_draft_assignments t
         WHERE draft_id = $1 ORDER BY id`,
        [ids.draft],
      );
    const assigned = await assignments();
    const lock = await callAction(
      page,
      [GENERATOR, "setAssignmentsLockedAction"],
      [{ draftId: ids.draft, version, groupIds: [b.group], locked: true }],
    );
    expectNoneOf(lock.body, bSecrets, "lock school B's group");
    expect(await assignments()).toEqual(assigned);
    expect(await liveData()).toEqual(liveDataOf(cBefore));
    expect(await schoolBRows(b)).toEqual(bBefore);
  });

  test("publishing the draft is what changes the live timetable", async () => {
    test.setTimeout(120_000);
    const admin = await as("admin");
    const { version } = await draftRow();
    const apply = (acknowledged: string[]) =>
      callAction(
        admin,
        [GENERATOR, "applyDraftAction"],
        [
          {
            draftId: ids.draft,
            version,
            acknowledgedConflictKeys: acknowledged,
            publish: false,
          },
        ],
      );
    let { result } = await apply([]);
    let outcome = result?.data as {
      ok: boolean;
      reason?: string;
      unacknowledged?: { key: string }[];
    };
    if (!outcome?.ok && outcome?.reason === "UNACKNOWLEDGED_CONFLICTS") {
      ({ result } = await apply(outcome.unacknowledged!.map((i) => i.key)));
      outcome = result?.data as typeof outcome;
    }
    expect(outcome, JSON.stringify(result)).toMatchObject({ ok: true });

    const lessons = (await liveTeachers()).filter((r) => r.kind === "lesson");
    expect(lessons.map((r) => r.teacher)).toEqual(
      Array(MONDAYS.length).fill(ids.colleague),
    );
    const colm = await serverResponse(
      await as("colleague"),
      `/teacher/timetable?week=${termStart}`,
    );
    expect(colm.body).toContain(NAMES.group);
  });
});

/** The draft's version (edits are refused on a stale one). */
async function draftRow() {
  const [row] = await sql<{ version: number }>(
    "SELECT version FROM timetable_drafts WHERE id = $1",
    [ids.draft],
  );
  return row;
}
