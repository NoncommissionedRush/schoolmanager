import { randomBytes, randomUUID } from "node:crypto";

import {
  type APIRequestContext,
  type Browser,
  expect,
  type Page,
  test,
} from "@playwright/test";

import { hashPassword } from "../../src/server/auth/password";
import {
  addDays,
  toZonedDateTime,
  zonedTimeToUtc,
} from "../../src/server/scheduling/time";
import { DEMO_PASSWORD, removeSchool, sql } from "../helpers";
import {
  type ActionResponse,
  callAction,
  pagesIn,
  PLACEHOLDER_ID,
  serverActionsIn,
} from "../server-actions";
import {
  expectNoneOf,
  isNotFound,
  type Role,
  schoolFingerprint,
  serverResponse,
  signedIn,
} from "./fixtures";

// Phase 5 permissions (CARM-67): notifications, substitutes, ratings and
// calendar links (docs/architecture/phase5-rules.md).
//
// - Notifications: everyone sees, counts and marks read only their own.
// - Substitutes: only the school's admins find and assign them; teachers
//   see only the covers they are part of.
// - Ratings: only students who attended enough lessons rate, only the
//   school's admins read them, by no page, action or API of anyone else.
// - Calendar links: a feed has only its owner's lessons; reset, revoked,
//   invalid and other schools' tokens get an empty 404.
//
// Two schools of its own, created and removed here: "C" and "D", the other
// tenant. Other specs fingerprint the seeded school B, so this spec writes
// none of its rows there (feeds, notifications, ratings).
//
// - C: Tilda teaches "group" (three ended lessons, two ahead); Rhea and
//   Stella have been in it since the term began, Sid joined yesterday.
//   Colm teaches "spare", Sid is in it too. Uma teaches nothing. The term
//   is half over today, so the rating window is open. Rhea already rated
//   Tilda.
// - D: Dex teaches Dina; Dina already rated Dex.

const TZ = "Europe/Bratislava";
const SUBSTITUTES = "src/app/admin/substitutions/actions.ts";
const ADMIN_RATINGS = "src/app/admin/ratings/actions.ts";
const STUDENT_RATINGS = "src/app/student/ratings/actions.ts";
const REVOKE = "src/app/admin/_people/calendar-actions.ts";
const FEED = "src/components/calendar-feed/actions.ts";
const INBOX = "src/components/notifications/actions.ts";
const FORBIDDEN = "You don't have access to this page";

const suffix = randomUUID().slice(0, 8);
const today = toZonedDateTime(new Date(), TZ).date;

type Who =
  | "admin"
  | "teacher"
  | "colleague"
  | "bystander"
  | "student"
  | "rater"
  | "newcomer"
  | "adminD"
  | "teacherD"
  | "studentD";

const PEOPLE: Record<Who, { school: "C" | "D"; role: Role; name: string }> = {
  admin: { school: "C", role: "admin", name: `Ada P5 ${suffix}` },
  teacher: { school: "C", role: "teacher", name: `Tilda P5 ${suffix}` },
  colleague: { school: "C", role: "teacher", name: `Colm P5 ${suffix}` },
  bystander: { school: "C", role: "teacher", name: `Uma P5 ${suffix}` },
  student: { school: "C", role: "student", name: `Stella P5 ${suffix}` },
  rater: { school: "C", role: "student", name: `Rhea P5 ${suffix}` },
  newcomer: { school: "C", role: "student", name: `Sid P5 ${suffix}` },
  adminD: { school: "D", role: "admin", name: `Dora P5 ${suffix}` },
  teacherD: { school: "D", role: "teacher", name: `Dex P5 ${suffix}` },
  studentD: { school: "D", role: "student", name: `Dina P5 ${suffix}` },
};
const EVERYONE = Object.keys(PEOPLE) as Who[];
const emailOf = (who: Who) =>
  `e2e-p5-${who.toLowerCase()}-${suffix}@phase5.test`;
const areaOf = (who: Who) => `/${PEOPLE[who].role}`;

const NAMES = {
  schoolC: `E2E Phase5 C ${suffix}`,
  schoolD: `E2E Phase5 D ${suffix}`,
  group: `P5 Group ${suffix}`,
  spare: `P5 Spare ${suffix}`,
  groupD: `P5 Group D ${suffix}`,
};

/** Rating comments: each may only reach the school's admins (and its author). */
const COMMENTS = {
  rater: `P5 rater comment ${suffix}`,
  student: `P5 student comment ${suffix}`,
  studentD: `P5 school D comment ${suffix}`,
};

/** Each person's one notification, told apart by the term name it shows. */
const inboxSecret = (who: Who) => `P5 inbox ${who} ${suffix}`;

const ids = {
  schoolC: randomUUID(),
  schoolD: randomUUID(),
  users: Object.fromEntries(EVERYONE.map((w) => [w, randomUUID()])) as Record<
    Who,
    string
  >,
  /** Teacher and student profiles, by person. */
  profiles: Object.fromEntries(
    EVERYONE.map((w) => [w, randomUUID()]),
  ) as Record<Who, string>,
  levelC: randomUUID(),
  levelD: randomUUID(),
  termC: randomUUID(),
  termD: randomUUID(),
  group: randomUUID(),
  spare: randomUUID(),
  groupD: randomUUID(),
  ratingC: randomUUID(),
  ratingD: randomUUID(),
  notifications: Object.fromEntries(
    EVERYONE.map((w) => [w, randomUUID()]),
  ) as Record<Who, string>,
};

type LessonRow = { id: string; date: string; startMinute: number };
const lessonsOf = (days: number[], startMinute: number): LessonRow[] =>
  days.map((d) => ({ id: randomUUID(), date: addDays(today, d), startMinute }));
const LESSONS = {
  /** Tilda's: three ended, two ahead. */
  group: lessonsOf([-14, -7, -3, 4, 11], 6 * 60),
  /** Colm's, an hour later. */
  spare: lessonsOf([-7, 4, 11], 7 * 60),
  groupD: lessonsOf([-3, 4], 6 * 60),
};
/** The lesson the admin covers with Colm (in four days). */
const COVERED = LESSONS.group[3];
const startsAtOf = (l: LessonRow) => zonedTimeToUtc(l.date, l.startMinute, TZ);

/** A substitute action's input for `lessonId` as last seen. */
const substitute = (
  lesson: LessonRow,
  extra: Record<string, unknown> = {},
) => ({
  lessonId: lesson.id,
  expectedSubstituteId: null,
  expectedStartsAt: startsAtOf(lesson).toISOString(),
  acknowledgedKeys: [],
  reason: null,
  ...extra,
});

type Case = {
  name: string;
  action: readonly [string, string];
  args: unknown[];
};

/** Every admin-only Phase 5 action, aimed at `t`, with valid input. */
function adminCases(t: {
  lesson: LessonRow;
  teacher: string;
  substitute: string;
  rating: string;
  user: string;
}): Case[] {
  return [
    {
      name: "open the substitute sheet",
      action: [SUBSTITUTES, "loadSubstituteSheetAction"],
      args: [t.lesson.id],
    },
    {
      name: "assign a substitute",
      action: [SUBSTITUTES, "assignSubstituteAction"],
      args: [substitute(t.lesson, { teacherId: t.substitute })],
    },
    {
      name: "remove a substitute",
      action: [SUBSTITUTES, "removeSubstituteAction"],
      args: [substitute(t.lesson, { expectedSubstituteId: t.substitute })],
    },
    {
      name: "cover a teacher (mark away)",
      action: [SUBSTITUTES, "coverTeacherAction"],
      args: [
        {
          teacherId: t.teacher,
          from: t.lesson.date,
          to: t.lesson.date,
          markAway: true,
        },
      ],
    },
    {
      name: "hide a rating",
      action: [ADMIN_RATINGS, "setRatingHiddenAction"],
      args: [{ ratingId: t.rating, hidden: true }],
    },
    {
      name: "turn off a calendar link",
      action: [REVOKE, "revokeCalendarFeedAction"],
      args: [t.user],
    },
  ];
}

const schoolC = () => ({
  lesson: COVERED,
  teacher: ids.profiles.teacher,
  substitute: ids.profiles.colleague,
  rating: ids.ratingC,
  user: ids.users.teacher,
});

/** A student's rating of `teacher` for `term`. */
const rate = (
  teacher: string,
  term: string,
  comment: string | null = null,
) => ({
  teacherId: teacher,
  termId: term,
  score: 4,
  comment,
});

/** Refused before the action ran: the role check answers, no `ActionResult`. */
function expectRoleRefusal(response: ActionResponse, name: string) {
  expect(response.result, name).toBeNull();
  expect(response.status, name).not.toBe(200);
}

/** Refused as "not found": the ids don't exist for the caller. */
function expectNotFound(
  response: ActionResponse,
  name: string,
  secrets: string[],
) {
  expect(response.status, name).toBe(200);
  expect(response.result?.ok, `${name}: ${response.body.slice(0, 300)}`).toBe(
    false,
  );
  expect(JSON.stringify(response.result), name).toMatch(/notFound/);
  expectNoneOf(response.body, secrets, name);
}

/** School C's names and comments, none of which may reach school D. */
const C_SECRETS = () => [
  NAMES.schoolC,
  NAMES.group,
  NAMES.spare,
  PEOPLE.teacher.name,
  PEOPLE.colleague.name,
  PEOPLE.student.name,
  COMMENTS.rater,
  COMMENTS.student,
];
const D_SECRETS = () => [
  NAMES.schoolD,
  NAMES.groupD,
  PEOPLE.teacherD.name,
  PEOPLE.studentD.name,
  COMMENTS.studentD,
];

const feedUrl = /\/api\/calendar\/[A-Za-z0-9_-]{43}\.ics/;

/** UIDs of the lessons in an iCalendar body. */
const uidsIn = (body: string) =>
  [...body.matchAll(/^UID:lesson-([0-9a-f-]{36})@schoolmanager/gm)]
    .map((m) => m[1])
    .sort();
const idsOf = (...lists: LessonRow[][]) =>
  lists
    .flat()
    .map((l) => l.id)
    .sort();

test.describe("phase 5 permissions", () => {
  test.describe.configure({ mode: "serial" });

  let browserRef: Browser;
  /** No session, like a calendar app. */
  let anonymous: APIRequestContext;
  const pages = new Map<Who, Page>();
  /** A signed-in page for `who`, shared by the tests of this file. */
  const as = async (who: Who) => {
    if (!pages.has(who)) {
      pages.set(
        who,
        await signedIn(browserRef, emailOf(who), PEOPLE[who].role),
      );
    }
    return pages.get(who)!;
  };
  /** Feed URLs by owner, as their calendar page shows them. */
  const links = new Map<Who, string>();

  test.beforeAll(async ({ browser, playwright }) => {
    browserRef = browser;
    anonymous = await playwright.request.newContext({
      baseURL: test.info().project.use.baseURL,
    });
    const hash = await hashPassword(DEMO_PASSWORD);
    const schoolOf = (who: Who) =>
      PEOPLE[who].school === "C" ? ids.schoolC : ids.schoolD;

    for (const [id, name, slug] of [
      [ids.schoolC, NAMES.schoolC, "c"],
      [ids.schoolD, NAMES.schoolD, "d"],
    ]) {
      await sql(
        `INSERT INTO schools (id, name, slug, timezone, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [id, name, `e2e-phase5-${slug}-${suffix}`, TZ],
      );
    }
    await sql(
      `INSERT INTO levels (id, school_id, code, name, rank, updated_at)
       VALUES ($1, $2, 'P5', 'Phase 5', 1, now()), ($3, $4, 'P5', 'Phase 5', 1, now())`,
      [ids.levelC, ids.schoolC, ids.levelD, ids.schoolD],
    );
    // Half over today: rating opened at half-term, closes 14 days after.
    for (const [id, school] of [
      [ids.termC, ids.schoolC],
      [ids.termD, ids.schoolD],
    ]) {
      await sql(
        `INSERT INTO terms (id, school_id, name, start_date, end_date, timetable_published_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())`,
        [
          id,
          school,
          `P5 Term ${suffix}`,
          addDays(today, -40),
          addDays(today, 30),
        ],
      );
    }
    for (const who of EVERYONE) {
      const { role, name } = PEOPLE[who];
      const school = schoolOf(who);
      await sql(
        `INSERT INTO users (id, email, name, password_hash, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [ids.users[who], emailOf(who), name, hash],
      );
      await sql(
        `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3::"Role", now())`,
        [school, ids.users[who], role.toUpperCase()],
      );
      const level = school === ids.schoolC ? ids.levelC : ids.levelD;
      if (role === "teacher") {
        await sql(
          `INSERT INTO teacher_profiles (id, school_id, user_id, updated_at)
           VALUES ($1, $2, $3, now())`,
          [ids.profiles[who], school, ids.users[who]],
        );
        await sql(
          `INSERT INTO teacher_levels (id, school_id, teacher_id, level_id)
           VALUES (gen_random_uuid(), $1, $2, $3)`,
          [school, ids.profiles[who], level],
        );
      }
      if (role === "student") {
        await sql(
          `INSERT INTO student_profiles (id, school_id, user_id, level_id, updated_at)
           VALUES ($1, $2, $3, $4, now())`,
          [ids.profiles[who], school, ids.users[who], level],
        );
      }
      // One notification each (a term name is the only parameter).
      await sql(
        `INSERT INTO notifications (id, school_id, recipient_id, type, audience, params, source_key)
         VALUES ($1, $2, $3, 'TIMETABLE_PUBLISHED', 'teacher', $4, $5)`,
        [
          ids.notifications[who],
          school,
          ids.users[who],
          JSON.stringify({ term: inboxSecret(who) }),
          `e2e-p5:${who}`,
        ],
      );
    }
    const groups: [string, string, string, string, Who, LessonRow[]][] = [
      [
        ids.group,
        ids.schoolC,
        ids.levelC,
        NAMES.group,
        "teacher",
        LESSONS.group,
      ],
      [
        ids.spare,
        ids.schoolC,
        ids.levelC,
        NAMES.spare,
        "colleague",
        LESSONS.spare,
      ],
      [
        ids.groupD,
        ids.schoolD,
        ids.levelD,
        NAMES.groupD,
        "teacherD",
        LESSONS.groupD,
      ],
    ];
    for (const [group, school, level, name, teacher, lessons] of groups) {
      await sql(
        `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at)
         VALUES ($1, $2, $3, 'GROUP', $4, 8, now())`,
        [group, school, level, name],
      );
      for (const lesson of lessons) {
        await sql(
          `INSERT INTO lessons (id, school_id, term_id, group_id, teacher_id, starts_at, ends_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '45 minutes', now())`,
          [
            lesson.id,
            school,
            school === ids.schoolC ? ids.termC : ids.termD,
            group,
            ids.profiles[teacher],
            startsAtOf(lesson),
          ],
        );
      }
    }
    const since = zonedTimeToUtc(addDays(today, -40), 0, TZ);
    const yesterday = zonedTimeToUtc(addDays(today, -1), 0, TZ);
    for (const [group, school, who, joined] of [
      [ids.group, ids.schoolC, "student", since],
      [ids.group, ids.schoolC, "rater", since],
      [ids.group, ids.schoolC, "newcomer", yesterday],
      [ids.spare, ids.schoolC, "newcomer", since],
      [ids.groupD, ids.schoolD, "studentD", since],
    ] as const) {
      await sql(
        `INSERT INTO group_memberships (id, school_id, group_id, student_id, joined_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
        [school, group, ids.profiles[who], joined],
      );
    }
    for (const [id, school, student, teacher, term, comment] of [
      [ids.ratingC, ids.schoolC, "rater", "teacher", ids.termC, COMMENTS.rater],
      [
        ids.ratingD,
        ids.schoolD,
        "studentD",
        "teacherD",
        ids.termD,
        COMMENTS.studentD,
      ],
    ] as const) {
      await sql(
        `INSERT INTO teacher_ratings (id, school_id, student_id, teacher_id, term_id, score, comment, updated_at)
         VALUES ($1, $2, $3, $4, $5, 2, $6, now())`,
        [
          id,
          school,
          ids.profiles[student],
          ids.profiles[teacher],
          term,
          comment,
        ],
      );
    }

    // In dev, actions compile with the pages that use them.
    for (const [who, path] of [
      ["admin", "/admin/substitutions"],
      ["admin", `/admin/ratings/${ids.profiles.teacher}`],
      ["admin", `/admin/teachers/${ids.profiles.teacher}`],
      ["student", "/student/calendar"],
      ["student", `/student/ratings/${ids.profiles.teacher}`],
      ["student", "/student/notifications"],
    ] as const) {
      await (await as(who)).goto(path);
    }
  });

  test.afterAll(async () => {
    for (const page of pages.values()) await page.context().close();
    await anonymous.dispose();
    await removeSchool(ids.schoolC);
    await removeSchool(ids.schoolD);
    await sql("DELETE FROM users WHERE id = ANY($1::uuid[])", [
      Object.values(ids.users),
    ]);
  });

  test("the cases cover every Phase 5 action", () => {
    const covered = [
      ...adminCases(schoolC()).map((c) => c.action.join("#")),
      `${STUDENT_RATINGS}#saveRatingAction`,
      `${FEED}#createCalendarFeedAction`,
      `${FEED}#resetCalendarFeedAction`,
      `${INBOX}#listNotificationsAction`,
      `${INBOX}#markReadAction`,
      `${INBOX}#markAllReadAction`,
    ].sort();
    expect(covered).toEqual(
      [
        ...serverActionsIn("src/app/admin/substitutions"),
        ...serverActionsIn("src/app/admin/ratings"),
        ...serverActionsIn("src/app/admin/_people").filter((key) =>
          key.startsWith(`${REVOKE}#`),
        ),
        ...serverActionsIn("src/app/student/ratings"),
        ...serverActionsIn("src/components/calendar-feed"),
        ...serverActionsIn("src/components/notifications"),
      ].sort(),
    );
  });

  test.describe("notifications", () => {
    /** The ids and unread count of `who`'s notifications, from the DB. */
    const own = async (who: Who) => {
      const rows = await sql<{ id: string; read: boolean }>(
        `SELECT id, read_at IS NOT NULL AS read FROM notifications
         WHERE recipient_id = $1`,
        [ids.users[who]],
      );
      return {
        ids: rows.map((r) => r.id).sort(),
        unread: rows.filter((r) => !r.read).length,
      };
    };
    const inboxOf = (who: Who) => `${areaOf(who)}/notifications`;

    test("everyone sees and counts only their own", async () => {
      for (const who of EVERYONE) {
        const page = await as(who);
        const others = EVERYONE.filter((w) => w !== who).map(inboxSecret);
        const mine = await own(who);
        expect(mine.ids, who).toContain(ids.notifications[who]);

        const inbox = await serverResponse(page, inboxOf(who));
        expect(inbox.status, who).toBe(200);
        expect(inbox.body, who).toContain(inboxSecret(who));
        expectNoneOf(inbox.body, others, `${who}'s inbox`);

        const listed = await callAction(
          page,
          [INBOX, "listNotificationsAction"],
          [{}],
          inboxOf(who),
        );
        const result = listed.result as unknown as {
          items: { id: string }[];
          unread: number;
        };
        expect(result.items.map((i) => i.id).sort(), who).toEqual(mine.ids);
        expect(result.unread, who).toBe(mine.unread);
        expectNoneOf(listed.body, others, `${who}'s list`);

        const count = await page.request.get("/api/notifications/unread");
        expect(await count.json(), who).toEqual({ count: mine.unread });
      }
    });

    test("nobody marks another user's notification read", async () => {
      const readAt = () =>
        sql<{ id: string; read_at: Date | null }>(
          "SELECT id, read_at FROM notifications WHERE id = ANY($1::uuid[]) ORDER BY id",
          [Object.values(ids.notifications)],
        );
      const before = await readAt();
      for (const who of ["student", "teacher", "admin", "adminD"] as const) {
        const page = await as(who);
        for (const other of EVERYONE.filter((w) => w !== who)) {
          const { result } = await callAction(
            page,
            [INBOX, "markReadAction"],
            [ids.notifications[other]],
            inboxOf(who),
          );
          expect(result, `${who} → ${other}`).toEqual({
            ok: false,
            href: null,
          });
        }
      }
      expect(await readAt()).toEqual(before);

      // "Mark all as read" marks only the caller's.
      const page = await as("student");
      const all = await callAction(
        page,
        [INBOX, "markAllReadAction"],
        [`${new Date(Date.now() + 60_000).toISOString()}|${PLACEHOLDER_ID}`],
        inboxOf("student"),
      );
      expect(all.result).toEqual({ ok: true, unread: 0 });
      const after = await readAt();
      for (const row of after) {
        const mine = row.id === ids.notifications.student;
        expect(row.read_at !== null, row.id).toBe(mine);
      }

      // Signed out, the count is refused.
      const count = await anonymous.get("/api/notifications/unread");
      expect(count.status()).toBe(401);
    });
  });

  test.describe("substitutes", () => {
    for (const who of ["teacher", "colleague", "student"] as const) {
      test(`a ${who} can't open the substitute pages or run their actions`, async () => {
        const page = await as(who);
        const paths = [
          "/admin/substitutions",
          `/admin/lessons/${COVERED.id}`,
          ...(who === "student" ? ["/teacher/substitutions"] : []),
        ];
        for (const path of paths) {
          const response = await serverResponse(page, path);
          expect(response.status, path).toBe(403);
          expectNoneOf(
            response.body,
            [NAMES.spare, PEOPLE.bystander.name],
            path,
          );
          await page.goto(path);
          await expect(
            page.getByRole("heading", { name: FORBIDDEN }),
            path,
          ).toBeVisible();
        }

        const before = await schoolFingerprint(ids.schoolC);
        for (const c of adminCases(schoolC())) {
          expectRoleRefusal(await callAction(page, c.action, c.args), c.name);
        }
        expect(await schoolFingerprint(ids.schoolC)).toEqual(before);
      });
    }

    test("an admin of another school can't see, cover or use the school's lessons and teachers", async () => {
      const page = await as("adminD");
      const list = await serverResponse(page, "/admin/substitutions");
      expect(list.status).toBe(200);
      expectNoneOf(list.body, C_SECRETS(), "school D's substitutions");
      const lesson = await serverResponse(page, `/admin/lessons/${COVERED.id}`);
      expect(isNotFound(lesson.body)).toBe(true);
      expectNoneOf(lesson.body, C_SECRETS(), "school C's lesson");

      const before = await schoolFingerprint(ids.schoolC);
      for (const c of adminCases(schoolC()).slice(0, 4)) {
        expectNotFound(
          await callAction(page, c.action, c.args),
          c.name,
          C_SECRETS(),
        );
      }
      expect(await schoolFingerprint(ids.schoolC)).toEqual(before);

      // Nor can school C's admin cover with school D's teacher, or theirs.
      const admin = await as("admin");
      const beforeD = await schoolFingerprint(ids.schoolD);
      const assign = await callAction(
        admin,
        [SUBSTITUTES, "assignSubstituteAction"],
        [substitute(COVERED, { teacherId: ids.profiles.teacherD })],
      );
      expect(assign.status).toBe(200);
      expect(
        (assign.result?.data as { status?: string } | undefined)?.status,
        JSON.stringify(assign.result),
      ).not.toBe("done");
      expectNoneOf(assign.body, D_SECRETS(), "assign school D's teacher");
      const cover = await callAction(
        admin,
        [SUBSTITUTES, "coverTeacherAction"],
        [
          {
            teacherId: ids.profiles.teacherD,
            from: COVERED.date,
            to: COVERED.date,
            markAway: true,
          },
        ],
      );
      expectNotFound(cover, "cover school D's teacher", D_SECRETS());
      expect(await schoolFingerprint(ids.schoolD)).toEqual(beforeD);
      expect(await schoolFingerprint(ids.schoolC)).toEqual(before);
    });

    test("the admin covers a lesson; only the teachers involved see it", async () => {
      const admin = await as("admin");
      const sheet = await callAction(
        admin,
        [SUBSTITUTES, "loadSubstituteSheetAction"],
        [COVERED.id],
      );
      expect(sheet.result?.ok, sheet.body.slice(0, 300)).toBe(true);
      expect(sheet.body).toContain(PEOPLE.colleague.name);
      expectNoneOf(sheet.body, D_SECRETS(), "the substitute sheet");

      const assign = (acknowledgedKeys: string[]) =>
        callAction(
          admin,
          [SUBSTITUTES, "assignSubstituteAction"],
          [
            substitute(COVERED, {
              teacherId: ids.profiles.colleague,
              acknowledgedKeys,
            }),
          ],
        );
      type Outcome = { status: string; reasons?: { key: string }[] };
      let outcome = (await assign([])).result?.data as Outcome;
      if (outcome?.status === "unacknowledged") {
        outcome = (await assign(outcome.reasons!.map((r) => r.key))).result
          ?.data as Outcome;
      }
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        status: "done",
      });

      const covering = await serverResponse(
        await as("colleague"),
        "/teacher/substitutions",
      );
      expect(covering.body).toContain(NAMES.group);
      const coveredFor = await serverResponse(
        await as("teacher"),
        "/teacher/substitutions",
      );
      expect(coveredFor.body).toContain(NAMES.group);
      expect(coveredFor.body).toContain(PEOPLE.colleague.name);
      for (const who of ["bystander", "teacherD"] as const) {
        const { body } = await serverResponse(
          await as(who),
          "/teacher/substitutions",
        );
        expectNoneOf(
          body,
          [NAMES.group, PEOPLE.teacher.name, PEOPLE.colleague.name],
          `${who}'s substitutions`,
        );
      }
    });
  });

  test.describe("ratings", () => {
    const ratings = () =>
      sql<{ row: string }>(
        `SELECT t::text AS row FROM teacher_ratings t
         WHERE school_id = ANY($1::uuid[]) ORDER BY id`,
        [[ids.schoolC, ids.schoolD]],
      );

    test("only students who attended enough lessons rate their teacher", async () => {
      const before = await ratings();
      const refusals: [Who, string, ReturnType<typeof rate>][] = [
        ["newcomer", "too few lessons", rate(ids.profiles.teacher, ids.termC)],
        [
          "student",
          "a teacher who never taught them",
          rate(ids.profiles.colleague, ids.termC),
        ],
        [
          "student",
          "a teacher with no lessons",
          rate(ids.profiles.bystander, ids.termC),
        ],
        [
          "student",
          "another school's teacher",
          rate(ids.profiles.teacherD, ids.termD),
        ],
        [
          "student",
          "their teacher in another school's term",
          rate(ids.profiles.teacher, ids.termD),
        ],
        [
          "studentD",
          "another school's teacher (their term)",
          rate(ids.profiles.teacher, ids.termD),
        ],
        [
          "studentD",
          "another school's teacher and term",
          rate(ids.profiles.teacher, ids.termC),
        ],
      ];
      for (const [who, name, input] of refusals) {
        expectNotFound(
          await callAction(
            await as(who),
            [STUDENT_RATINGS, "saveRatingAction"],
            [input],
          ),
          `${who}: ${name}`,
          [...C_SECRETS(), ...D_SECRETS()].filter(
            (s) => s !== PEOPLE[who].name,
          ),
        );
      }
      for (const who of ["teacher", "admin", "adminD"] as const) {
        expectRoleRefusal(
          await callAction(
            await as(who),
            [STUDENT_RATINGS, "saveRatingAction"],
            [rate(ids.profiles.teacher, ids.termC)],
          ),
          `${who} rates`,
        );
      }
      expect(await ratings()).toEqual(before);

      const saved = await callAction(
        await as("student"),
        [STUDENT_RATINGS, "saveRatingAction"],
        [rate(ids.profiles.teacher, ids.termC, COMMENTS.student)],
      );
      expect(saved.result, saved.body.slice(0, 300)).toEqual({
        ok: true,
        data: { status: "saved", created: true },
      });
      expectNoneOf(saved.body, [COMMENTS.rater], "the saved rating");
    });

    test("teachers and students read no ratings on any page", async () => {
      const comments = Object.values(COMMENTS);
      const admin = await serverResponse(
        await as("admin"),
        `/admin/ratings/${ids.profiles.teacher}`,
      );
      expect(admin.body).toContain(COMMENTS.rater);
      expect(admin.body).toContain(COMMENTS.student);
      expectNoneOf(admin.body, [COMMENTS.studentD], "school C's ratings");

      const fill = (path: string) =>
        path.startsWith("/student/ratings/")
          ? path.replace(PLACEHOLDER_ID, ids.profiles.teacher)
          : path.replace(PLACEHOLDER_ID, COVERED.id);
      const adminPaths = [
        "/admin/ratings",
        `/admin/ratings/${ids.profiles.teacher}`,
      ];
      const readers: [Who, string, string[]][] = [
        ["teacher", "src/app/teacher", comments],
        ["colleague", "src/app/teacher", comments],
        ["bystander", "src/app/teacher", comments],
        // Stella sees her own comment, nobody else's.
        ["student", "src/app/student", [COMMENTS.rater, COMMENTS.studentD]],
        ["newcomer", "src/app/student", comments],
        ["teacherD", "src/app/teacher", comments],
      ];
      for (const [who, dir, secrets] of readers) {
        const page = await as(who);
        for (const path of adminPaths) {
          const response = await serverResponse(page, path);
          expect(response.status, `${who} ${path}`).toBe(403);
          expectNoneOf(response.body, comments, `${who} ${path}`);
        }
        for (const path of pagesIn(dir).map(fill)) {
          const { body } = await serverResponse(page, path);
          expectNoneOf(body, secrets, `${who} ${path}`);
        }
        const list = await callAction(
          page,
          [INBOX, "listNotificationsAction"],
          [{}],
          `${areaOf(who)}/notifications`,
        );
        expectNoneOf(list.body, comments, `${who}'s notifications`);
      }
    });

    test("only the school's admins hide them", async () => {
      const before = await ratings();
      for (const who of ["teacher", "student"] as const) {
        expectRoleRefusal(
          await callAction(
            await as(who),
            [ADMIN_RATINGS, "setRatingHiddenAction"],
            [{ ratingId: ids.ratingC, hidden: true }],
          ),
          `${who} hides`,
        );
      }

      // Each school's admin: the other's ratings don't exist.
      for (const [who, rating, teacher, secrets] of [
        ["adminD", ids.ratingC, ids.profiles.teacher, C_SECRETS()],
        ["admin", ids.ratingD, ids.profiles.teacherD, D_SECRETS()],
      ] as const) {
        const page = await as(who);
        const overview = await serverResponse(page, "/admin/ratings");
        expect(overview.status, who).toBe(200);
        expectNoneOf(overview.body, secrets, `${who}'s ratings overview`);
        const detail = await serverResponse(page, `/admin/ratings/${teacher}`);
        expect(isNotFound(detail.body), who).toBe(true);
        expectNoneOf(detail.body, secrets, `${who} on the other's teacher`);
        expectNotFound(
          await callAction(
            page,
            [ADMIN_RATINGS, "setRatingHiddenAction"],
            [{ ratingId: rating, hidden: true }],
          ),
          `${who} hides the other school's rating`,
          secrets,
        );
      }
      expect(await ratings()).toEqual(before);
    });
  });

  test.describe("calendar links", () => {
    /** The feed URL on `who`'s calendar page (absolute, as copied). */
    const linkOf = async (who: Who) => {
      const { body } = await serverResponse(
        await as(who),
        `${areaOf(who)}/calendar`,
      );
      const path = feedUrl.exec(body)?.[0];
      expect(path, `${who}'s calendar link`).toBeTruthy();
      return path!;
    };
    const fetchFeed = async (path: string) => {
      const response = await anonymous.get(path, { failOnStatusCode: false });
      return { status: response.status(), body: await response.text() };
    };
    const expectGone = async (path: string, name: string) => {
      const response = await fetchFeed(path);
      expect(response.status, name).toBe(404);
      expect(response.body, name).toBe("");
    };

    test("a feed has only its owner's lessons", async () => {
      const owners: [Who, string[]][] = [
        ["student", idsOf(LESSONS.group)],
        // Joined the group yesterday: its lessons from then on.
        ["newcomer", idsOf(LESSONS.spare, LESSONS.group.slice(3))],
        ["teacher", idsOf(LESSONS.group)],
        // Colm covers one of Tilda's lessons.
        ["colleague", idsOf(LESSONS.spare, [COVERED])],
        ["bystander", []],
        ["studentD", idsOf(LESSONS.groupD)],
      ];
      for (const [who, expected] of owners) {
        const created = await callAction(
          await as(who),
          [FEED, "createCalendarFeedAction"],
          [],
          `${areaOf(who)}/calendar`,
        );
        expect(created.result, who).toEqual({ ok: true });
        links.set(who, await linkOf(who));
        const feed = await fetchFeed(links.get(who)!);
        expect(feed.status, who).toBe(200);
        expect(feed.body, who).toContain("BEGIN:VCALENDAR");
        expect(uidsIn(feed.body), who).toEqual(expected);
        const others = EVERYONE.filter((w) => w !== who).map(
          (w) => PEOPLE[w].name,
        );
        // Names in the feed: the teachers of the owner's lessons only.
        const shown = others.filter((name) => feed.body.includes(name));
        const teachers = [
          PEOPLE.teacher.name,
          PEOPLE.colleague.name,
          PEOPLE.teacherD.name,
        ];
        expect(
          shown.filter((n) => !teachers.includes(n)),
          who,
        ).toEqual([]);
      }
      // Two owners never share a link.
      expect(new Set(links.values()).size).toBe(links.size);

      // Admins have no calendar link.
      for (const who of ["admin", "adminD"] as const) {
        const page = await as(who);
        for (const path of ["/teacher/calendar", "/student/calendar"]) {
          const response = await callAction(
            page,
            [FEED, "createCalendarFeedAction"],
            [],
            path,
          );
          expectRoleRefusal(response, `${who} creates a link on ${path}`);
        }
      }
      const [{ count }] = await sql<{ count: number }>(
        "SELECT count(*)::int AS count FROM calendar_feeds WHERE user_id = ANY($1::uuid[])",
        [[ids.users.admin, ids.users.adminD]],
      );
      expect(count).toBe(0);
    });

    test("a reset or revoked link stops working", async () => {
      const old = links.get("student")!;
      const reset = await callAction(
        await as("student"),
        [FEED, "resetCalendarFeedAction"],
        [],
        "/student/calendar",
      );
      expect(reset.result).toEqual({ ok: true });
      await expectGone(old, "the link before the reset");
      const fresh = await linkOf("student");
      expect(fresh).not.toBe(old);
      expect((await fetchFeed(fresh)).status).toBe(200);
      links.set("student", fresh);

      // Teachers and students can't turn off anyone's link; another
      // school's admin finds no such user.
      for (const who of ["teacher", "student"] as const) {
        expectRoleRefusal(
          await callAction(
            await as(who),
            [REVOKE, "revokeCalendarFeedAction"],
            [ids.users.colleague],
          ),
          `${who} turns off a link`,
        );
      }
      expectNotFound(
        await callAction(
          await as("adminD"),
          [REVOKE, "revokeCalendarFeedAction"],
          [ids.users.student],
        ),
        "school D's admin turns off a link",
        C_SECRETS(),
      );
      for (const who of ["student", "colleague"] as const) {
        expect((await fetchFeed(links.get(who)!)).status, who).toBe(200);
      }

      // The school's admin turns Tilda's link off.
      const revoked = await callAction(
        await as("admin"),
        [REVOKE, "revokeCalendarFeedAction"],
        [ids.users.teacher],
      );
      expect(revoked.result).toEqual({ ok: true, data: { revoked: true } });
      await expectGone(links.get("teacher")!, "the revoked link");
      const page = await serverResponse(
        await as("teacher"),
        "/teacher/calendar",
      );
      expect(feedUrl.test(page.body)).toBe(false);
    });

    test("invalid tokens and tokens of another school get nothing", async () => {
      const token = /([A-Za-z0-9_-]{43})\.ics$/.exec(links.get("student")!)![1];
      // Built at runtime: random, never a real link.
      const random = randomBytes(32).toString("base64url");
      const flipped = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
      for (const [name, path] of [
        ["a random token", `/api/calendar/${random}.ics`],
        ["one character changed", `/api/calendar/${flipped}.ics`],
        ["no .ics", `/api/calendar/${token}`],
        ["upper-case .ICS", `/api/calendar/${token}.ICS`],
        ["too short", `/api/calendar/${token.slice(1)}.ics`],
        ["too long", `/api/calendar/${token}A.ics`],
        ["the token's hash", `/api/calendar/${"0".repeat(64)}.ics`],
        ["a lesson id", `/api/calendar/${COVERED.id}.ics`],
        ["an empty token", "/api/calendar/.ics"],
      ]) {
        await expectGone(path, name);
      }

      // Dina's link, on a feed row moved to school C: the feed is read in
      // the row's school, where she is nobody.
      const dina = links.get("studentD")!;
      const move = (school: string) =>
        sql(
          `UPDATE calendar_feeds SET school_id = $1
           WHERE user_id = $2 AND revoked_at IS NULL`,
          [school, ids.users.studentD],
        );
      await move(ids.schoolC);
      try {
        await expectGone(dina, "school D's link on a school C row");
      } finally {
        await move(ids.schoolD);
      }
      const back = await fetchFeed(dina);
      expect(back.status).toBe(200);
      expect(uidsIn(back.body)).toEqual(idsOf(LESSONS.groupD));

      // A student who left the school: their link stops working.
      await sql(`UPDATE memberships SET school_id = $1 WHERE user_id = $2`, [
        ids.schoolC,
        ids.users.studentD,
      ]);
      try {
        await expectGone(dina, "the link of a student now in another school");
      } finally {
        await sql(`UPDATE memberships SET school_id = $1 WHERE user_id = $2`, [
          ids.schoolD,
          ids.users.studentD,
        ]);
      }
    });
  });
});
