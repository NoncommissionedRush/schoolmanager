import { randomUUID } from "node:crypto";

import { type Browser, expect, type Page, test } from "@playwright/test";

import {
  addDays,
  toZonedDateTime,
  zonedTimeToUtc,
} from "../../src/server/scheduling/time";
import { currentTermId, DEMO_LOGINS, sql } from "../helpers";
import { callAction, FormFields, serverActionsIn } from "../server-actions";
import {
  expectNoneOf,
  isNotFound,
  LOGINS,
  SCHOOL_A,
  SCHOOL_B,
  schoolFingerprint,
  type SchoolIds,
  schoolIds,
  serverResponse,
  signedIn,
} from "./fixtures";

// Phase 3 permissions (CARM-44): absences, makeup credits, replacement
// bookings, 1-on-1 reschedules and the school's absence settings. Runs on
// its own groups, rooms, students and lessons in school A (in the term
// running today), so the seeded data and the specs running in parallel
// don't matter:
//
// - Rita (S1) and Sam (S2) are members of "own" and of nothing else; Rita
//   also has a 1-on-1 that starts in two hours (after the 24-hour cutoff).
//   Rita holds one AVAILABLE credit, one expired and one already used.
// - Otto (S3) is in "full", whose room seats one; Olga (S4) is in "other",
//   the group Rita books into. Nora (S5) is in no group at all.
// - "level" is a group of another level, the spec's own: picking an existing
//   one could take another spec's fixture level and block its cleanup.
//
// Every log, homework, note and reason carries a unique marker, so finding
// one in a response that shouldn't have it is the leak check.

const STUDENT = "src/app/student/absences/actions.ts";
const ADMIN = "src/app/admin/absences/actions.ts";
const SETTINGS = "src/app/admin/settings/absences/actions.ts";
const NOT_FOUND = "common.error.notFound";
const TZ = "Europe/Bratislava";
const HOUR = 3_600_000;

const suffix = randomUUID().slice(0, 8);
const mark = (what: string) => `CARM44-${what.toUpperCase()}-${suffix}`;
const MARKS = {
  log: mark("log"),
  homework: mark("homework"),
  lessonNote: mark("lesson-note"),
  studentNote: mark("olga-note"),
  olgaReason: mark("olga-reason"),
  ritaReason: mark("rita-reason"),
};
const NAMES = {
  rita: `Rita Phase3 ${suffix}`,
  sam: `Sam Phase3 ${suffix}`,
  otto: `Otto Phase3 ${suffix}`,
  olga: `Olga Phase3 ${suffix}`,
  nora: `Nora Phase3 ${suffix}`,
};
type Who = keyof typeof NAMES;
const WHO = Object.keys(NAMES) as Who[];
const emailOf = (who: Who) => `e2e-p3-${who}-${suffix}@demo-school.test`;

const ids = {
  term: "", // the current term (beforeAll)
  level: randomUUID(),
  room: randomUUID(),
  tinyRoom: randomUUID(),
  groups: {
    own: randomUUID(),
    other: randomUUID(),
    full: randomUUID(),
    level: randomUUID(),
    oneOnOne: randomUUID(),
  },
  users: Object.fromEntries(WHO.map((w) => [w, randomUUID()])) as Record<
    Who,
    string
  >,
  students: Object.fromEntries(WHO.map((w) => [w, randomUUID()])) as Record<
    Who,
    string
  >,
  lessons: {
    own1: randomUUID(), // own, +3 days 10:00: Rita's credit comes from it
    own2: randomUUID(), // own, +6 days 10:00: Rita attends it
    own3: randomUUID(), // own, +7 days 10:00: who may report an absence
    pastExpired: randomUUID(), // own, 40 days ago: the expired credit
    pastUsed: randomUUID(), // own, 35 days ago: the used credit
    target: randomUUID(), // other, +4 days 14:00: eligible
    full: randomUUID(), // full, +4 days 16:00: no free seat
    level: randomUUID(), // level, +4 days 18:00: another level
    clash: randomUUID(), // other, +6 days 10:30: clashes with own2
    started: randomUUID(), // other, started an hour ago
    lateOneOnOne: randomUUID(), // oneOnOne, in two hours
  },
  credits: {
    available: randomUUID(),
    expired: randomUUID(),
    used: randomUUID(),
  },
  absences: {
    available: randomUUID(),
    expired: randomUUID(),
    used: randomUUID(),
    olga: randomUUID(),
  },
};

const now = new Date();
const today = toZonedDateTime(now, TZ).date;
const at = (days: number, minute: number) =>
  zonedTimeToUtc(addDays(today, days), minute, TZ);

let a: SchoolIds;
let b: SchoolIds;
/** School B's student's credit (any state: the lookup is what's checked). */
let bCredit: string;
/** A school B lesson in the future. */
let bUpcoming: string;
let teacherProfile: string;

async function lessonRow(id: string) {
  const [row] = await sql<{ row: string }>(
    "SELECT l::text AS row FROM lessons l WHERE id = $1",
    [id],
  );
  return row?.row ?? "missing";
}

/**
 * Rita's absences, credits and bookings, as text. A credit past its expiry
 * may be marked EXPIRED lazily by any read; that alone isn't a change.
 */
async function ritaRows() {
  const [row] = await sql<{ row: string }>(
    `SELECT row(
       (SELECT string_agg(t::text, '|' ORDER BY t.id) FROM absence_reports t WHERE student_id = $1),
       (SELECT string_agg(row(t.id, t.used_at, t.rescheduled_lesson_id, t.expires_at,
          CASE WHEN t.status = 'EXPIRED' THEN 'AVAILABLE' ELSE t.status::text END)::text,
          '|' ORDER BY t.id) FROM makeup_credits t WHERE student_id = $1),
       (SELECT string_agg(t::text, '|' ORDER BY t.id) FROM replacement_requests t WHERE student_id = $1)
     )::text AS row`,
    [ids.students.rita],
  );
  return row.row;
}

async function absenceCount(lessonId: string, studentId: string) {
  const [row] = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM absence_reports
     WHERE lesson_id = $1 AND student_id = $2`,
    [lessonId, studentId],
  );
  return row.n;
}

/** The page renders "not found" (`isNotFound`) and none of `leaks`. */
async function expectPageNotFound(page: Page, path: string, leaks: string[]) {
  const { body } = await serverResponse(page, path);
  expect(isNotFound(body), path).toBe(true);
  expectNoneOf(body, leaks, path);
}

/** The page renders for the viewer (a control for the not-found checks). */
async function expectPageFound(page: Page, path: string) {
  const { status, body } = await serverResponse(page, path);
  expect(status, path).toBe(200);
  expect(isNotFound(body), path).toBe(false);
  return body;
}

/** The refusal codes of a `bookReplacementAction` result. */
function reasonCodes(response: Awaited<ReturnType<typeof callAction>>) {
  const data = response.result?.data as
    { reasons?: { code: string }[] } | undefined;
  return (data?.reasons ?? []).map((r) => r.code);
}

/** Refused as "not found": the id doesn't exist for the caller. */
function expectNotFound(
  response: Awaited<ReturnType<typeof callAction>>,
  name: string,
) {
  expect(response.status, name).toBe(200);
  expect(response.result, name).toMatchObject({
    ok: false,
    formError: { key: NOT_FOUND },
  });
}

/** The role check refused before the action ran: no `ActionResult`. */
function expectNoResult(
  response: Awaited<ReturnType<typeof callAction>>,
  name: string,
) {
  expect(response.result, name).toBeNull();
  expect(response.status, name).not.toBe(200);
}

/** Every student action, aimed at Rita's lesson, credit and booking. */
function studentCases(target: {
  lesson: string;
  oneOnOne: string;
  credit: string;
  booking: string;
  bookInto: string;
}) {
  const startsAt = at(9, 9 * 60).toISOString();
  return [
    {
      name: "cancel a lesson",
      action: [STUDENT, "cancelLessonAction"],
      args: [{ lessonId: target.lesson, reason: null }],
    },
    {
      name: "book with the credit",
      action: [STUDENT, "bookReplacementAction"],
      args: [{ creditId: target.credit, targetLessonId: target.bookInto }],
    },
    {
      name: "cancel the booking",
      action: [STUDENT, "cancelBookingAction"],
      args: [{ bookingId: target.booking }],
    },
    {
      name: "open the reschedule sheet of the 1-on-1",
      action: [STUDENT, "loadRescheduleSheetAction"],
      args: [{ lessonId: target.oneOnOne }],
    },
    {
      name: "open the reschedule sheet of the credit",
      action: [STUDENT, "loadRescheduleSheetAction"],
      args: [{ creditId: target.credit }],
    },
    {
      name: "reschedule the 1-on-1",
      action: [STUDENT, "rescheduleLessonAction"],
      args: [{ lessonId: target.oneOnOne, startsAt }],
    },
    {
      name: "reschedule with the credit",
      action: [STUDENT, "rescheduleLessonAction"],
      args: [{ creditId: target.credit, startsAt }],
    },
  ] as const;
}

test.describe("phase 3 permissions", () => {
  test.describe.configure({ mode: "serial" });

  /** Rita's booking into `target`, once the booking test made it. */
  let booking: string;
  let browserRef: Browser;
  type Login = Who | "teacher" | "admin" | "adminB";
  const pages = new Map<Login, Page>();
  /** A signed-in page for `who`, shared by the tests of this file. */
  const as = async (who: Login) => {
    if (!pages.has(who)) {
      const page =
        who === "teacher"
          ? await signedIn(browserRef, DEMO_LOGINS.teacher, "teacher")
          : who === "admin"
            ? await signedIn(browserRef, DEMO_LOGINS.admin, "admin")
            : who === "adminB"
              ? await signedIn(browserRef, LOGINS.B.admin, "admin")
              : await signedIn(browserRef, emailOf(who), "student");
      pages.set(who, page);
    }
    return pages.get(who)!;
  };

  test.beforeAll(async ({ browser }) => {
    browserRef = browser;
    a = await schoolIds(SCHOOL_A);
    b = await schoolIds(SCHOOL_B);
    [{ id: bCredit }] = await sql<{ id: string }>(
      "SELECT id FROM makeup_credits WHERE student_id = $1 ORDER BY id LIMIT 1",
      [b.student],
    );
    [{ id: bUpcoming }] = await sql<{ id: string }>(
      `SELECT id FROM lessons WHERE group_id = $1 AND starts_at > now() + interval '2 days'
       ORDER BY starts_at LIMIT 1`,
      [b.group],
    );

    const [row] = await sql<{
      level: string;
      teacher: string;
      hash: string;
    }>(
      `SELECT g.level_id AS level, tp.id AS teacher, su.password_hash AS hash
       FROM schools s
       JOIN groups g ON g.school_id = s.id AND g.name = 'A2 Evening'
       JOIN teacher_profiles tp ON tp.school_id = s.id
       JOIN users u ON u.id = tp.user_id AND u.email = $1
       JOIN users su ON su.email = $2
       WHERE s.slug = $3`,
      [DEMO_LOGINS.teacher, DEMO_LOGINS.student, SCHOOL_A],
    );
    teacherProfile = row.teacher;
    const school = a.school;

    // Terms never overlap: the lessons go into the term running today.
    ids.term = await currentTermId(school, today, addDays(today, 33));
    await sql(
      `INSERT INTO rooms (id, school_id, name, kind, capacity, updated_at)
       VALUES ($1, $3, $4, 'PHYSICAL', 5, now()), ($2, $3, $5, 'PHYSICAL', 1, now())`,
      [
        ids.room,
        ids.tinyRoom,
        school,
        `P3 Room ${suffix}`,
        `P3 Tiny ${suffix}`,
      ],
    );
    // E2E-% codes are left out of the role suite's level count.
    await sql(
      `INSERT INTO levels (id, school_id, code, name, rank, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [
        ids.level,
        school,
        `E2E-P3-${suffix}`,
        `P3 Level ${suffix}`,
        9001 + parseInt(suffix.slice(0, 4), 16),
      ],
    );
    const g = ids.groups;
    await sql(
      `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at) VALUES
         ($1, $6, $7, 'GROUP', $9, 8, now()),
         ($2, $6, $7, 'GROUP', $10, 8, now()),
         ($3, $6, $7, 'GROUP', $11, 8, now()),
         ($4, $6, $8, 'GROUP', $12, 8, now()),
         ($5, $6, $7, 'ONE_ON_ONE', $13, 1, now())`,
      [
        g.own,
        g.other,
        g.full,
        g.level,
        g.oneOnOne,
        school,
        row.level,
        ids.level,
        `P3 Own ${suffix}`,
        `P3 Other ${suffix}`,
        `P3 Full ${suffix}`,
        `P3 Level ${suffix}`,
        `P3 One ${suffix}`,
      ],
    );
    for (const who of WHO) {
      await sql(
        `INSERT INTO users (id, email, name, password_hash, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [ids.users[who], emailOf(who), NAMES[who], row.hash],
      );
      await sql(
        `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'STUDENT', now())`,
        [school, ids.users[who]],
      );
      await sql(
        `INSERT INTO student_profiles (id, school_id, user_id, level_id, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [ids.students[who], school, ids.users[who], row.level],
      );
    }
    const members: [Who, string][] = [
      ["rita", g.own],
      ["rita", g.oneOnOne],
      ["sam", g.own],
      ["otto", g.full],
      ["olga", g.other],
    ];
    for (const [who, group] of members) {
      await sql(
        `INSERT INTO group_memberships (id, school_id, group_id, student_id, joined_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now() - interval '50 days', now())`,
        [school, group, ids.students[who]],
      );
    }

    const l = ids.lessons;
    const lessons: [string, string, string | null, Date, number][] = [
      [l.own1, g.own, ids.room, at(3, 10 * 60), 90],
      [l.own2, g.own, ids.room, at(6, 10 * 60), 90],
      [l.own3, g.own, ids.room, at(7, 10 * 60), 90],
      [l.pastExpired, g.own, ids.room, at(-40, 10 * 60), 90],
      [l.pastUsed, g.own, ids.room, at(-35, 10 * 60), 90],
      [l.target, g.other, ids.room, at(4, 14 * 60), 90],
      [l.full, g.full, ids.tinyRoom, at(4, 16 * 60), 90],
      [l.level, g.level, ids.room, at(4, 18 * 60), 90],
      [l.clash, g.other, ids.room, at(6, 10 * 60 + 30), 90],
      [l.started, g.other, ids.room, new Date(now.getTime() - HOUR), 90],
      [
        l.lateOneOnOne,
        g.oneOnOne,
        null,
        new Date(now.getTime() + 2 * HOUR),
        45,
      ],
    ];
    for (const [id, group, room, startsAt, minutes] of lessons) {
      await sql(
        `INSERT INTO lessons (id, school_id, term_id, group_id, teacher_id, room_id, starts_at, ends_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7::timestamptz + make_interval(mins => $8), now())`,
        [id, school, ids.term, group, row.teacher, room, startsAt, minutes],
      );
    }

    // Rita's credits: available (from own1), expired and used.
    const credits: [string, string, string, string, Date, string | null][] = [
      [
        ids.absences.available,
        ids.credits.available,
        l.own1,
        "AVAILABLE",
        at(33, 0),
        MARKS.ritaReason,
      ],
      [
        ids.absences.expired,
        ids.credits.expired,
        l.pastExpired,
        "AVAILABLE", // past expires_at: EXPIRED, brought up to date lazily
        at(-10, 0),
        null,
      ],
      [
        ids.absences.used,
        ids.credits.used,
        l.pastUsed,
        "USED",
        at(20, 0),
        null,
      ],
    ];
    for (const [
      absence,
      credit,
      lesson,
      status,
      expiresAt,
      reason,
    ] of credits) {
      await sql(
        `INSERT INTO absence_reports (id, school_id, lesson_id, student_id, reported_by_id, reason, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())`,
        [absence, school, lesson, ids.students.rita, ids.users.rita, reason],
      );
      await sql(
        `INSERT INTO makeup_credits (id, school_id, student_id, source_lesson_id, absence_report_id, status, expires_at, used_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::"MakeupCreditStatus", $7,
                 CASE WHEN $6 = 'USED' THEN now() END, now())`,
        [credit, school, ids.students.rita, lesson, absence, status, expiresAt],
      );
    }
    // Olga misses the target lesson, with a reason Rita must never see.
    await sql(
      `INSERT INTO absence_reports (id, school_id, lesson_id, student_id, reported_by_id, reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [
        ids.absences.olga,
        school,
        l.target,
        ids.students.olga,
        ids.users.olga,
        MARKS.olgaReason,
      ],
    );
  });

  test.afterAll(async () => {
    for (const page of pages.values()) await page.context().close();
    const students = Object.values(ids.students);
    const groups = Object.values(ids.groups);
    // By group: the lessons share the term running today with other specs.
    const lessons = await sql<{ id: string }>(
      "SELECT id FROM lessons WHERE group_id = ANY($1)",
      [groups],
    );
    const lessonIds = lessons.map((l) => l.id);
    await sql("DELETE FROM replacement_requests WHERE student_id = ANY($1)", [
      students,
    ]);
    await sql("DELETE FROM makeup_credits WHERE student_id = ANY($1)", [
      students,
    ]);
    await sql("DELETE FROM absence_reports WHERE student_id = ANY($1)", [
      students,
    ]);
    await sql("DELETE FROM lesson_logs WHERE lesson_id = ANY($1)", [lessonIds]);
    await sql(
      "DELETE FROM teacher_notes WHERE lesson_id = ANY($1) OR student_id = ANY($2)",
      [lessonIds, students],
    );
    // A reschedule points at the lesson it replaces (Restrict), and may be
    // rescheduled again: unlink the chains, then delete.
    await sql(
      "UPDATE lessons SET rescheduled_from_id = NULL WHERE id = ANY($1)",
      [lessonIds],
    );
    await sql("DELETE FROM lessons WHERE id = ANY($1)", [lessonIds]);
    await sql("DELETE FROM group_memberships WHERE student_id = ANY($1)", [
      students,
    ]);
    await sql("DELETE FROM student_profiles WHERE id = ANY($1)", [students]);
    const users = Object.values(ids.users);
    await sql("DELETE FROM memberships WHERE user_id = ANY($1)", [users]);
    await sql("DELETE FROM users WHERE id = ANY($1)", [users]);
    await sql("DELETE FROM groups WHERE id = ANY($1)", [groups]);
    await sql("DELETE FROM levels WHERE id = $1", [ids.level]);
    await sql("DELETE FROM rooms WHERE id = ANY($1)", [
      [ids.room, ids.tinyRoom],
    ]);
  });

  test("the cases cover every student server action", () => {
    const covered = new Set(
      studentCases({
        lesson: "",
        oneOnOne: "",
        credit: "",
        booking: "",
        bookInto: "",
      }).map(({ action }) => action.join("#")),
    );
    const declared = serverActionsIn("src/app/student");
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((key) => !covered.has(key))).toEqual([]);
  });

  test("booking outside the rules is refused on the server", async () => {
    const rita = await as("rita");
    const before = await ritaRows();
    const book = (creditId: string, targetLessonId: string) =>
      callAction(
        rita,
        [STUDENT, "bookReplacementAction"],
        [{ creditId, targetLessonId }],
      );
    const refusals: [string, string, string, string][] = [
      [
        "another level",
        ids.credits.available,
        ids.lessons.level,
        "LEVEL_MISMATCH",
      ],
      ["a full room", ids.credits.available, ids.lessons.full, "ROOM_FULL"],
      ["a clash", ids.credits.available, ids.lessons.clash, "STUDENT_CLASH"],
      [
        "a started lesson",
        ids.credits.available,
        ids.lessons.started,
        "LESSON_STARTED",
      ],
      [
        "an expired credit",
        ids.credits.expired,
        ids.lessons.target,
        "CREDIT_UNAVAILABLE",
      ],
      [
        "a used credit",
        ids.credits.used,
        ids.lessons.target,
        "CREDIT_UNAVAILABLE",
      ],
      [
        "the 1-on-1",
        ids.credits.available,
        ids.lessons.lateOneOnOne,
        "NOT_A_GROUP_LESSON",
      ],
      [
        "their own group",
        ids.credits.available,
        ids.lessons.own2,
        "ALREADY_ATTENDING",
      ],
    ];
    for (const [name, credit, target, code] of refusals) {
      const { status, result } = await book(credit, target);
      expect(status, name).toBe(200);
      expect(result, name).toMatchObject({
        ok: true,
        data: { status: "refused" },
      });
      expect(reasonCodes({ status, result, body: "" }), name).toContain(code);
    }
    expect(await ritaRows()).toEqual(before);

    // Control: the eligible lesson books, with the available credit.
    const booked = await book(ids.credits.available, ids.lessons.target);
    expect(booked.result).toMatchObject({
      ok: true,
      data: { status: "booked" },
    });
    booking = (booked.result?.data as { bookingId: string }).bookingId;

    // Spent now: the same credit can't book a second lesson.
    const again = await book(ids.credits.available, ids.lessons.clash);
    expect(reasonCodes(again)).toContain("CREDIT_UNAVAILABLE");
    const [{ n }] = await sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM replacement_requests WHERE student_id = $1",
      [ids.students.rita],
    );
    expect(n).toBe(1);
  });

  test("a student uses only their own credits and bookings", async () => {
    const sam = await as("sam");
    const before = await ritaRows();
    for (const c of studentCases({
      lesson: ids.lessons.own1, // Sam's own lesson too: left out below
      oneOnOne: ids.lessons.lateOneOnOne,
      credit: ids.credits.available,
      booking,
      bookInto: ids.lessons.clash,
    })) {
      if (c.name === "cancel a lesson") continue;
      expectNotFound(await callAction(sam, c.action, [...c.args]), c.name);
    }
    expect(await ritaRows()).toEqual(before);

    // Rita's credit, reason and booking never reach Sam's pages.
    for (const path of ["/student", "/student/absences"]) {
      const { status, body } = await serverResponse(sam, path);
      expect(status, path).toBe(200);
      expectNoneOf(
        body,
        [ids.credits.available, booking, MARKS.ritaReason, NAMES.rita],
        path,
      );
    }
    const credit = `/student/absences/book?credit=${ids.credits.available}`;
    await expectPageNotFound(sam, credit, [MARKS.ritaReason, NAMES.rita]);

    // Control: Rita sees her own.
    await expectPageFound(await as("rita"), credit);
  });

  test("only the student or an admin of their school reports an absence", async () => {
    const lesson = ids.lessons.own3;
    const rita = ids.students.rita;

    // A teacher: neither the student's action nor the admin's runs.
    const teacher = await as("teacher");
    expectNoResult(
      await callAction(
        teacher,
        [STUDENT, "cancelLessonAction"],
        [{ lessonId: lesson, reason: null }],
      ),
      "teacher › cancel",
    );
    expectNoResult(
      await callAction(
        teacher,
        [ADMIN, "reportAbsenceAction"],
        [{ studentId: rita, lessonId: lesson, reason: null }],
      ),
      "teacher › report",
    );

    // Another student can't name Rita: the action only ever reports the
    // signed-in student, and Nora isn't in the group.
    const nora = await as("nora");
    expectNotFound(
      await callAction(
        nora,
        [STUDENT, "cancelLessonAction"],
        [{ lessonId: lesson, studentId: rita, reason: null }],
      ),
      "another student › cancel for Rita",
    );
    // Sam is in the group: the absence is his, never Rita's.
    const sam = await as("sam");
    const own = await callAction(
      sam,
      [STUDENT, "cancelLessonAction"],
      [{ lessonId: lesson, studentId: rita, reason: null }],
    );
    expect(own.result).toMatchObject({
      ok: true,
      data: { status: "reported" },
    });
    expect(await absenceCount(lesson, ids.students.sam)).toBe(1);

    // An admin of another school.
    const adminB = await as("adminB");
    expectNotFound(
      await callAction(
        adminB,
        [ADMIN, "reportAbsenceAction"],
        [{ studentId: rita, lessonId: lesson, reason: null }],
      ),
      "admin of school B › report",
    );
    expect(await absenceCount(lesson, rita)).toBe(0);

    // Control: an admin of Rita's school can.
    const admin = await as("admin");
    const reported = await callAction(
      admin,
      [ADMIN, "reportAbsenceAction"],
      [{ studentId: rita, lessonId: lesson, reason: null }],
    );
    expect(reported.result).toMatchObject({
      ok: true,
      data: { status: "reported" },
    });
    expect(await absenceCount(lesson, rita)).toBe(1);
  });

  test("only admins review, change settings and reschedule after the cutoff", async () => {
    const lateLesson = ids.lessons.lateOneOnOne;
    const review = [
      {
        name: "approve",
        action: [ADMIN, "approveReplacementsAction"],
        args: [[booking]],
      },
      {
        name: "reject",
        action: [ADMIN, "rejectReplacementAction"],
        args: [{ bookingId: booking, note: "Not allowed" }],
      },
      {
        name: "override",
        action: [ADMIN, "overrideReplacementAction"],
        args: [
          {
            bookingId: booking,
            targetLessonId: null,
            acknowledgedKeys: [],
            note: "Not allowed",
          },
        ],
      },
      {
        name: "override options",
        action: [ADMIN, "loadOverrideOptionsAction"],
        args: [booking, true],
      },
      {
        name: "settings",
        action: [SETTINGS, "saveAbsenceSettingsAction"],
        args: [
          null,
          new FormFields({
            cutoffHours: "0",
            validDays: "365",
          }),
        ],
      },
      {
        name: "admin reschedule",
        action: [ADMIN, "rescheduleLessonAction"],
        args: [
          {
            lessonId: lateLesson,
            date: addDays(today, 8),
            startMinute: 8 * 60,
            durationMinutes: 45,
            roomId: null,
            acknowledgedKeys: [],
            note: null,
          },
        ],
      },
      {
        name: "cancel a rescheduled lesson",
        action: [ADMIN, "cancelRescheduledLessonAction"],
        args: [lateLesson],
      },
    ] as const;
    const [school] = await sql<{ row: string }>(
      "SELECT s::text AS row FROM schools s WHERE id = $1",
      [a.school],
    );
    const before = [await ritaRows(), await lessonRow(lateLesson), school.row];
    const snapshot = async () => [
      await ritaRows(),
      await lessonRow(lateLesson),
      (
        await sql<{ row: string }>(
          "SELECT s::text AS row FROM schools s WHERE id = $1",
          [a.school],
        )
      )[0].row,
    ];
    for (const who of ["rita", "teacher"] as const) {
      const page = await as(who);
      for (const c of review) {
        expectNoResult(
          await callAction(page, c.action, [...c.args]),
          `${who} › ${c.name}`,
        );
      }
    }
    expect(await snapshot()).toEqual(before);

    // The student can't move her 1-on-1 after the cutoff …
    const rita = await as("rita");
    for (const [name, response] of [
      [
        "sheet",
        await callAction(
          rita,
          [STUDENT, "loadRescheduleSheetAction"],
          [{ lessonId: lateLesson }],
        ),
      ],
      [
        "reschedule",
        await callAction(
          rita,
          [STUDENT, "rescheduleLessonAction"],
          [{ lessonId: lateLesson, startsAt: at(8, 8 * 60).toISOString() }],
        ),
      ],
    ] as const) {
      expect(response.result, name).toMatchObject({
        ok: false,
        formError: { key: "reschedule.errors.CUTOFF_PASSED" },
      });
    }
    expect(await lessonRow(lateLesson)).toEqual(before[1]);

    // … an admin can.
    const admin = await as("admin");
    const move = review.find((c) => c.name === "admin reschedule")!;
    let moved = await callAction(admin, move.action, [...move.args]);
    const first = moved.result as {
      ok: boolean;
      data?: {
        status: string;
        conflicts?: { key: string }[];
        reasons?: { key: string }[];
      };
    };
    expect(first.ok).toBe(true);
    if (first.data?.status === "conflicts") {
      const keys = [
        ...(first.data.conflicts ?? []),
        ...(first.data.reasons ?? []),
      ].map((c) => c.key);
      moved = await callAction(admin, move.action, [
        { ...move.args[0], acknowledgedKeys: keys },
      ]);
    }
    expect(moved.result).toMatchObject({
      ok: true,
      data: { status: "rescheduled" },
    });
  });

  test("a replacement student reads the lesson's log and homework, nothing more", async () => {
    const target = ids.lessons.target;
    const path = `/student/lessons/${target}`;
    const start = async (startsAt: Date) =>
      sql(
        `UPDATE lessons SET starts_at = $2, ends_at = $2::timestamptz + interval '90 minutes'
         WHERE id = $1`,
        [target, startsAt],
      );
    const startedAgo = new Date(Date.now() - 2 * HOUR);
    const originalStart = at(4, 14 * 60);

    await sql(
      `INSERT INTO lesson_logs (id, school_id, lesson_id, author_id, updated_by_id, content, homework, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $3, $4, $5, now())`,
      [a.school, target, teacherProfile, MARKS.log, MARKS.homework],
    );
    await sql(
      `INSERT INTO teacher_notes (id, school_id, author_id, student_id, group_id, lesson_id, body, updated_at)
       VALUES (gen_random_uuid(), $1, $2, NULL, NULL, $3, $4, now()),
              (gen_random_uuid(), $1, $2, $5, NULL, $3, $6, now())`,
      [
        a.school,
        teacherProfile,
        target,
        MARKS.lessonNote,
        ids.students.olga,
        MARKS.studentNote,
      ],
    );
    const hidden = [
      MARKS.lessonNote,
      MARKS.studentNote,
      MARKS.olgaReason,
      NAMES.olga,
      ids.students.olga,
    ];

    const rita = await as("rita");
    await start(startedAgo);
    try {
      const body = await expectPageFound(rita, path);
      expect(body).toContain(MARKS.log);
      expect(body).toContain(MARKS.homework);
      expectNoneOf(body, hidden, path);
      const homework = await serverResponse(rita, "/student/homework");
      expect(homework.body).toContain(MARKS.homework);
      expectNoneOf(homework.body, hidden, "/student/homework");

      // Sam isn't booked: not found.
      await expectPageNotFound(await as("sam"), path, [MARKS.log]);
    } finally {
      await start(originalStart);
    }

    // The admin rejects the booking before the lesson; access ends.
    const admin = await as("admin");
    const rejected = await callAction(
      admin,
      [ADMIN, "rejectReplacementAction"],
      [{ bookingId: booking, note: "Room needed for an exam" }],
    );
    expect(rejected.result).toMatchObject({
      ok: true,
      data: { status: "done" },
    });

    await start(startedAgo);
    try {
      await expectPageNotFound(rita, path, [
        MARKS.log,
        MARKS.homework,
        ...hidden,
      ]);
      const homework = await serverResponse(rita, "/student/homework");
      expectNoneOf(
        homework.body,
        [MARKS.log, MARKS.homework, ...hidden],
        "/student/homework",
      );
    } finally {
      await start(originalStart);
    }
  });

  test("a student of school B can't touch school A's absences, credits or bookings", async ({
    browser,
  }) => {
    const page = await signedIn(browser, LOGINS.B.student, "student");
    const before = await ritaRows();
    const lessons = await Promise.all(
      Object.values(ids.lessons).map(lessonRow),
    );
    const cases = [
      ...studentCases({
        lesson: ids.lessons.own2,
        oneOnOne: ids.lessons.lateOneOnOne,
        credit: ids.credits.available,
        booking,
        bookInto: ids.lessons.clash,
      }),
      {
        name: "book their own credit into school A's lesson",
        action: [STUDENT, "bookReplacementAction"],
        args: [{ creditId: bCredit, targetLessonId: ids.lessons.clash }],
      } as const,
    ];
    for (const c of cases) {
      expectNotFound(await callAction(page, c.action, [...c.args]), c.name);
    }
    expect(await ritaRows()).toEqual(before);
    expect(
      await Promise.all(Object.values(ids.lessons).map(lessonRow)),
    ).toEqual(lessons);

    const book = `/student/absences/book?credit=${ids.credits.available}`;
    await expectPageNotFound(page, book, Object.values(NAMES));
    const absences = await serverResponse(page, "/student/absences");
    expect(absences.status).toBe(200);
    expectNoneOf(
      absences.body,
      [
        ...Object.values(NAMES),
        MARKS.ritaReason,
        ...Object.values(ids.credits),
      ],
      "/student/absences",
    );
    await page.context().close();
  });

  test("a student of school A can't touch school B's", async () => {
    const rita = await as("rita");
    const before = await schoolFingerprint(b.school);
    for (const c of studentCases({
      lesson: bUpcoming,
      oneOnOne: bUpcoming,
      credit: bCredit,
      booking: b.replacement,
      bookInto: bUpcoming,
    })) {
      expectNotFound(await callAction(rita, c.action, [...c.args]), c.name);
    }
    expect(await schoolFingerprint(b.school)).toEqual(before);
    const book = `/student/absences/book?credit=${bCredit}`;
    await expectPageNotFound(rita, book, ["Bianca Bauer"]);
  });
});
