import { randomUUID } from "node:crypto";

import { type Browser, expect, type Page, test } from "@playwright/test";

import { insertOwnTerm, signIn, sql } from "../helpers";
import { addDays } from "../../src/server/scheduling/time";
import { callAction, pagesIn, serverActionsIn } from "../server-actions";
import { teacherLessonCases } from "./action-cases";
import {
  expectNoneOf,
  isNotFound,
  LOGINS,
  SCHOOL_A,
  SCHOOL_B,
  SECOND_NAMES,
  schoolFingerprint,
  type SchoolIds,
  schoolIds,
  serverResponse,
  signedIn,
} from "./fixtures";

// Phase 2 permission suite (CARM-37, lessons.md §2): lesson logs, homework
// and TeacherNotes.
// - Teachers write only on lessons they teach or substitute, once started.
// - Admins read every lesson of their school and write nothing.
// - Students write nothing and read only lessons of their groups, from the
//   day they joined until they left, once started, in published terms.
//   Anything else is 404.
// - TeacherNotes never reach a student, in any page or action response.
// - None of it crosses schools.
//
// The spec builds its own lessons in school A (a colleague teaches them,
// the demo teacher substitutes some) and its own student, who joined one
// group ten days ago and left another one, so the seeded data and the
// specs running in parallel are left alone. Every log, homework and note
// carries a unique marker; a marker in a response that shouldn't have it
// is a leak.

test.describe.configure({ mode: "serial" });

const suffix = randomUUID().slice(0, 8);
const marker = (what: string) => `CARM37 ${what} ${suffix}`;
const TEACHER_ACTIONS = "src/app/teacher/lessons/actions.ts";
const ADMIN_ACTIONS = "src/app/admin/lessons/actions.ts";
const NOT_FOUND = { ok: false, formError: { key: "common.error.notFound" } };

type GroupKey = "joined" | "left" | "other";

type LessonFixture = {
  group: GroupKey;
  /** Start relative to now, in hours. Lessons last 90 minutes. */
  startsIn: number;
  /** The demo teacher substitutes (a colleague always teaches). */
  substitute?: boolean;
  draftTerm?: boolean;
  cancelled?: boolean;
  log?: boolean;
  /** Expected: the spec's student may open it. */
  studentSees: boolean;
  /** Expected: the demo teacher may open it. */
  teacherOpens: boolean;
};

const DAY = 24;

// The student joined "joined" 10 days ago and was in "left" from 30 to 10
// days ago; never in "other".
const LESSONS = {
  beforeJoining: {
    group: "joined",
    startsIn: -20 * DAY,
    log: true,
    studentSees: false,
    teacherOpens: false,
  },
  substituted: {
    group: "joined",
    startsIn: -2 * DAY,
    substitute: true,
    log: true,
    studentSees: true,
    teacherOpens: true,
  },
  colleagues: {
    group: "joined",
    startsIn: -1 * DAY,
    log: true,
    studentSees: true,
    teacherOpens: false,
  },
  cancelled: {
    group: "joined",
    startsIn: -4 * DAY,
    substitute: true,
    cancelled: true,
    studentSees: true,
    teacherOpens: true,
  },
  // A log on a lesson that hasn't started (e.g. written, then the lesson
  // moved): never shown to the student, not writable.
  future: {
    group: "joined",
    startsIn: 3 * DAY,
    substitute: true,
    log: true,
    studentSees: false,
    teacherOpens: true,
  },
  draft: {
    group: "joined",
    startsIn: -12,
    substitute: true,
    draftTerm: true,
    log: true,
    studentSees: false,
    teacherOpens: false,
  },
  whileMember: {
    group: "left",
    startsIn: -20 * DAY,
    log: true,
    studentSees: true,
    teacherOpens: false,
  },
  afterLeaving: {
    group: "left",
    startsIn: -5 * DAY,
    log: true,
    studentSees: false,
    teacherOpens: false,
  },
  otherGroup: {
    group: "other",
    startsIn: -2 * DAY,
    log: true,
    studentSees: false,
    teacherOpens: false,
  },
} satisfies Record<string, LessonFixture>;

type LessonKey = keyof typeof LESSONS;
const lessonKeys = Object.keys(LESSONS) as LessonKey[];

/** The log texts of a lesson: what a leak of it would show. */
const logOf = (key: LessonKey) => ({
  content: marker(`covered in ${key}`),
  homework: marker(`homework of ${key}`),
});
const logMarkers = (key: LessonKey) => Object.values(logOf(key));

// Notes, by the colleague unless `byDemoTeacher`.
const NOTES = {
  aboutStudent: { lesson: "substituted", about: "student" },
  aboutGroup: { lesson: "colleagues", about: "group" },
  onLesson: { lesson: "whileMember", about: "lesson" },
  otherGroup: { lesson: "otherGroup", about: "lesson" },
  unattached: { lesson: null, about: "student" },
  demoTeachers: { lesson: "substituted", about: "lesson", byDemoTeacher: true },
} as const satisfies Record<
  string,
  {
    lesson: LessonKey | null;
    about: "student" | "group" | "lesson";
    byDemoTeacher?: boolean;
  }
>;
type NoteKey = keyof typeof NOTES;
const noteBody = (key: NoteKey) => marker(`internal note ${key}`);
const allNoteBodies = () => (Object.keys(NOTES) as NoteKey[]).map(noteBody);
/** Bodies of the notes written on a lesson. */
const notesOn = (lesson: LessonKey) =>
  (Object.keys(NOTES) as NoteKey[])
    .filter((key) => NOTES[key].lesson === lesson)
    .map(noteBody);

const ids = {
  term: randomUUID(),
  draftTerm: randomUUID(),
  user: randomUUID(),
  student: randomUUID(),
  groups: { joined: randomUUID(), left: randomUUID(), other: randomUUID() },
  lessons: Object.fromEntries(lessonKeys.map((k) => [k, randomUUID()])) as {
    [K in LessonKey]: string;
  },
  notes: Object.fromEntries(
    Object.keys(NOTES).map((k) => [k, randomUUID()]),
  ) as { [K in NoteKey]: string },
};
const groupName = (key: GroupKey) => `CARM37 ${key} ${suffix}`;
const studentEmail = `carm37-${suffix}@demo-school.test`;
const studentName = `Carm Leakcheck ${suffix}`;

let a: SchoolIds;
let b: SchoolIds;
let colleague: string;

test.beforeAll(async () => {
  a = await schoolIds(SCHOOL_A);
  b = await schoolIds(SCHOOL_B);
  const [row] = await sql<{ colleague: string; level: string; hash: string }>(
    `SELECT
       (SELECT id FROM teacher_profiles WHERE school_id = $1 AND id <> $2
          AND id::text LIKE '________-____-5%' ORDER BY id LIMIT 1) AS colleague,
       (SELECT level_id FROM groups WHERE id = $3) AS level,
       (SELECT password_hash FROM users WHERE id = $4) AS hash`,
    [a.school, a.teacher, a.group, a.studentUser],
  );
  colleague = row.colleague;

  // January terms, away from the weeks and terms other specs look at.
  const published = await insertOwnTerm({
    id: ids.term,
    schoolId: a.school,
    name: marker("term"),
    startDate: "2026-01-19",
    days: 7,
    published: true,
  });
  await insertOwnTerm({
    id: ids.draftTerm,
    schoolId: a.school,
    name: marker("draft term"),
    startDate: addDays(published.endDate, 1),
    days: 6,
    published: false,
  });
  for (const key of ["joined", "left", "other"] as const) {
    await sql(
      `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at)
       VALUES ($1, $2, $3, 'GROUP', $4, 8, now())`,
      [ids.groups[key], a.school, row.level, groupName(key)],
    );
  }
  await sql(
    `INSERT INTO users (id, email, name, password_hash, updated_at)
     VALUES ($1, $2, $3, $4, now())`,
    [ids.user, studentEmail, studentName, row.hash],
  );
  await sql(
    `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'STUDENT', now())`,
    [a.school, ids.user],
  );
  await sql(
    `INSERT INTO student_profiles (id, school_id, user_id, updated_at)
     VALUES ($1, $2, $3, now())`,
    [ids.student, a.school, ids.user],
  );
  await sql(
    `INSERT INTO group_memberships (id, school_id, group_id, student_id, joined_at, left_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $4, now() - interval '10 days', NULL, now()),
            (gen_random_uuid(), $1, $3, $4, now() - interval '30 days', now() - interval '10 days', now())`,
    [a.school, ids.groups.joined, ids.groups.left, ids.student],
  );

  for (const key of lessonKeys) {
    const l: LessonFixture = LESSONS[key];
    await sql(
      `INSERT INTO lessons (id, school_id, term_id, group_id, teacher_id, substitute_teacher_id,
                            starts_at, ends_at, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               now() + make_interval(hours => $7), now() + make_interval(hours => $7, mins => 90),
               $8::"LessonStatus", now())`,
      [
        ids.lessons[key],
        a.school,
        l.draftTerm ? ids.draftTerm : ids.term,
        ids.groups[l.group],
        colleague,
        l.substitute ? a.teacher : null,
        l.startsIn,
        l.cancelled ? "CANCELLED" : "SCHEDULED",
      ],
    );
    if (l.log) {
      const { content, homework } = logOf(key);
      await sql(
        `INSERT INTO lesson_logs (id, school_id, lesson_id, author_id, updated_by_id, content, homework, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $3, $4, $5, now())`,
        [a.school, ids.lessons[key], colleague, content, homework],
      );
    }
  }

  for (const [key, note] of Object.entries(NOTES) as [
    NoteKey,
    (typeof NOTES)[NoteKey],
  ][]) {
    const groupKey = note.lesson ? LESSONS[note.lesson].group : "joined";
    await sql(
      `INSERT INTO teacher_notes (id, school_id, author_id, student_id, group_id, lesson_id, body, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [
        ids.notes[key],
        a.school,
        "byDemoTeacher" in note ? a.teacher : colleague,
        note.about === "student" ? ids.student : null,
        note.about === "group" ? ids.groups[groupKey] : null,
        note.lesson ? ids.lessons[note.lesson] : null,
        noteBody(key),
      ],
    );
  }
});

test.afterAll(async () => {
  const lessons = Object.values(ids.lessons);
  const groups = Object.values(ids.groups);
  await sql(
    `DELETE FROM teacher_notes
     WHERE lesson_id = ANY($1) OR group_id = ANY($2) OR student_id = $3`,
    [lessons, groups, ids.student],
  );
  await sql("DELETE FROM lesson_logs WHERE lesson_id = ANY($1)", [lessons]);
  await sql("DELETE FROM lessons WHERE id = ANY($1)", [lessons]);
  await sql("DELETE FROM group_memberships WHERE group_id = ANY($1)", [groups]);
  await sql("DELETE FROM student_profiles WHERE id = $1", [ids.student]);
  await sql("DELETE FROM memberships WHERE user_id = $1", [ids.user]);
  await sql("DELETE FROM users WHERE id = $1", [ids.user]);
  await sql("DELETE FROM groups WHERE id = ANY($1)", [groups]);
  await sql("DELETE FROM terms WHERE id = ANY($1)", [
    [ids.term, ids.draftTerm],
  ]);
});

/** Every log and note of the spec's lessons, groups and student, as text. */
async function records() {
  return sql<{ row: string }>(
    `SELECT t::text AS row FROM lesson_logs t WHERE lesson_id = ANY($1)
     UNION ALL
     SELECT t::text FROM teacher_notes t
     WHERE lesson_id = ANY($1) OR group_id = ANY($2) OR student_id = $3
     ORDER BY 1`,
    [Object.values(ids.lessons), Object.values(ids.groups), ids.student],
  );
}

async function signInStudent(browser: Browser) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, studentEmail);
  await page.waitForURL("/student");
  return page;
}

/**
 * The lesson pages render "not found" and nothing of the lesson. Not-found
 * inside a streamed page keeps HTTP 200, so check the digest (`isNotFound`).
 */
async function expectNotFound(page: Page, path: string, leaks: string[]) {
  const { body } = await serverResponse(page, path);
  expect(isNotFound(body), path).toBe(true);
  expectNoneOf(body, leaks, path);
}

/** Monday of each spec lesson's week, for the timetable pages. */
async function lessonWeeks() {
  const rows = await sql<{ week: string }>(
    `SELECT DISTINCT to_char(date_trunc('week', starts_at), 'YYYY-MM-DD') AS week
     FROM lessons WHERE id = ANY($1)`,
    [Object.values(ids.lessons)],
  );
  return rows.map((r) => r.week);
}

/** Under `pnpm dev`, actions exist once a page using them compiled. */
async function compileLessonActions(browser: Browser) {
  if (process.env.CI) return;
  const admin = await signedIn(browser, LOGINS.A.admin, "admin");
  for (const path of pagesIn("src/app/admin/lessons")) {
    await admin.request.get(path);
  }
  const teacher = await signedIn(browser, LOGINS.A.teacher, "teacher");
  for (const path of pagesIn("src/app/teacher/lessons")) {
    await teacher.request.get(path);
  }
}

test("the cases cover every teacher server action; students have none", () => {
  const covered = new Set(
    teacherLessonCases({ lesson: "", teacherNote: "", student: "" }).map(
      ({ action }) => action.join("#"),
    ),
  );
  const declared = serverActionsIn("src/app/teacher");
  expect(declared.length).toBeGreaterThan(0);
  expect(declared.filter((key) => !covered.has(key))).toEqual([]);
  // Students write no lesson records (lessons.md §2). Their only actions
  // are absences, bookings and reschedules (absences.md §5, CARM-42/43),
  // which take no log, homework or note; the Phase 3 suite (CARM-44)
  // covers them.
  expect(serverActionsIn("src/app/student").sort()).toEqual([
    "src/app/student/absences/actions.ts#bookReplacementAction",
    "src/app/student/absences/actions.ts#cancelBookingAction",
    "src/app/student/absences/actions.ts#cancelLessonAction",
    "src/app/student/absences/actions.ts#loadRescheduleSheetAction",
    "src/app/student/absences/actions.ts#rescheduleLessonAction",
  ]);
});

test.describe("lesson records › students", () => {
  test("a student opens only lessons of their groups, from joining, once started", async ({
    browser,
  }) => {
    const page = await signInStudent(browser);
    const hidden = lessonKeys.filter((k) => !LESSONS[k].studentSees);
    const hiddenMarkers = hidden.flatMap(logMarkers);
    const notes = allNoteBodies();

    for (const key of lessonKeys) {
      const path = `/student/lessons/${ids.lessons[key]}`;
      if (LESSONS[key].studentSees) {
        const { status, body } = await serverResponse(page, path);
        expect(status, path).toBe(200);
        if ("log" in LESSONS[key]) {
          for (const text of logMarkers(key))
            expect(body, path).toContain(text);
        }
        expectNoneOf(body, [...hiddenMarkers, ...notes], path);
      } else {
        await expectNotFound(page, path, [
          ...logMarkers(key),
          groupName(LESSONS[key].group),
          ...notes,
        ]);
      }
    }
    await expectNotFound(page, "/student/lessons/not-a-uuid", notes);

    // Lists: the Homework tab (with every group filter a student could
    // try), the home card and the timetable weeks of all spec lessons.
    const visible = lessonKeys.filter(
      (k) => LESSONS[k].studentSees && "log" in LESSONS[k],
    );
    const homework = await serverResponse(page, "/student/homework?shown=1000");
    for (const key of visible) {
      for (const text of logMarkers(key)) expect(homework.body).toContain(text);
    }
    const paths = [
      "/student",
      "/student/homework",
      "/student/homework?shown=1000",
      ...(["joined", "left", "other"] as const).map(
        (g) => `/student/homework?shown=1000&group=${ids.groups[g]}`,
      ),
      `/student/homework?group=${a.group}`,
      ...(await lessonWeeks()).flatMap((week) => [
        `/student/timetable?week=${week}`,
        `/student/timetable?week=${week}&view=day`,
      ]),
    ];
    for (const path of paths) {
      const { status, body } = await serverResponse(page, path);
      expect(status, path).toBe(200);
      expectNoneOf(body, [...hiddenMarkers, ...notes], path);
      expectNoneOf(body, [groupName("other")], path);
    }
    // The timetable shows a started lesson's homework, never the log.
    for (const path of paths.filter((p) => p.includes("timetable"))) {
      const { body } = await serverResponse(page, path);
      expectNoneOf(
        body,
        lessonKeys.map((k) => logOf(k).content),
        path,
      );
    }
  });

  test("a student can't run any lesson action, and gets no note back", async ({
    browser,
  }) => {
    await compileLessonActions(browser);
    const page = await signInStudent(browser);
    const notes = allNoteBodies();
    const before = await records();
    for (const key of ["substituted", "colleagues", "whileMember"] as const) {
      const cases = [
        ...teacherLessonCases({
          lesson: ids.lessons[key],
          teacherNote: ids.notes.aboutStudent,
          student: ids.student,
        }),
        {
          name: "admin: load earlier notes",
          action: [ADMIN_ACTIONS, "loadEarlierNotesAction"] as const,
          args: [ids.lessons[key], 0],
        },
      ];
      for (const c of cases) {
        const { status, result, body } = await callAction(
          page,
          c.action,
          c.args,
        );
        expect(result, `${key}: ${c.name}`).toBeNull();
        expect(status, `${key}: ${c.name}`).not.toBe(200);
        expectNoneOf(body, notes, `${key}: ${c.name}`);
      }
    }
    expect(await records()).toEqual(before);
  });
});

test.describe("lesson records › teachers", () => {
  test("a teacher opens only lessons they teach or substitute", async ({
    browser,
  }) => {
    const page = await signedIn(browser, LOGINS.A.teacher, "teacher");
    for (const key of lessonKeys) {
      const path = `/teacher/lessons/${ids.lessons[key]}`;
      if (LESSONS[key].teacherOpens) {
        const { status } = await serverResponse(page, path);
        expect(status, path).toBe(200);
      } else {
        await expectNotFound(page, path, [...logMarkers(key), ...notesOn(key)]);
      }
    }
  });

  test("a teacher can't write on lessons they don't teach, or change others' notes", async ({
    browser,
  }) => {
    await compileLessonActions(browser);
    const page = await signedIn(browser, LOGINS.A.teacher, "teacher");
    const before = await records();

    for (const key of lessonKeys.filter((k) => !LESSONS[k].teacherOpens)) {
      for (const c of teacherLessonCases({
        lesson: ids.lessons[key],
        teacherNote: ids.notes.otherGroup,
        student: ids.student,
      })) {
        const { status, result } = await callAction(page, c.action, c.args);
        expect(status, `${key}: ${c.name}`).toBe(200);
        expect(result, `${key}: ${c.name}`).toMatchObject(NOT_FOUND);
      }
    }

    // A colleague's notes, also on a lesson the teacher substitutes (they
    // read it there, but only the author may change it).
    for (const note of ["aboutStudent", "aboutGroup", "unattached"] as const) {
      for (const name of ["updateNoteAction", "deleteNoteAction"]) {
        const args =
          name === "deleteNoteAction"
            ? [ids.notes[note]]
            : [{ noteId: ids.notes[note], body: "Overwritten" }];
        const { result } = await callAction(
          page,
          [TEACHER_ACTIONS, name],
          args,
        );
        expect(result, `${note}: ${name}`).toMatchObject(NOT_FOUND);
      }
    }

    // Before the lesson starts and once it's cancelled, the log is locked.
    for (const [key, lock] of [
      ["future", "notStarted"],
      ["cancelled", "cancelled"],
    ] as const) {
      const { result } = await callAction(
        page,
        [TEACHER_ACTIONS, "saveLessonLogAction"],
        [
          {
            lessonId: ids.lessons[key],
            content: "Too early",
            homework: "",
            expectedUpdatedAt: null,
          },
        ],
      );
      expect(result, key).toMatchObject({
        ok: false,
        formError: { key: `lessonLog.locked.${lock}` },
      });
    }
    expect(await records()).toEqual(before);
  });

  test("a substitute writes the log, homework and notes of their lesson (control)", async ({
    browser,
  }) => {
    // The same calls the refusals above use, accepted on a lesson the
    // demo teacher substitutes: the refusals are about access, not shape.
    const page = await signedIn(browser, LOGINS.A.teacher, "teacher");
    const lessonId = ids.lessons.substituted;
    const [log] = await sql<{ updated: string }>(
      `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated
       FROM lesson_logs WHERE lesson_id = $1`,
      [lessonId],
    );
    const updated = { ...logOf("substituted") };
    updated.homework = marker("homework of substituted, edited");
    const save = await callAction(
      page,
      [TEACHER_ACTIONS, "saveLessonLogAction"],
      [{ lessonId, ...updated, expectedUpdatedAt: log.updated }],
    );
    expect(save.result).toMatchObject({ ok: true, data: { status: "saved" } });
    const note = await callAction(
      page,
      [TEACHER_ACTIONS, "createNoteAction"],
      [
        {
          lessonId,
          about: `student:${ids.student}`,
          body: noteBody("aboutStudent"),
        },
      ],
    );
    expect(note.result).toMatchObject({ ok: true });
    const edit = await callAction(
      page,
      [TEACHER_ACTIONS, "updateNoteAction"],
      [{ noteId: ids.notes.demoTeachers, body: noteBody("demoTeachers") }],
    );
    expect(edit.result).toMatchObject({ ok: true });
  });
});

test.describe("lesson records › admins", () => {
  test("an admin reads every lesson of the school, notes included", async ({
    browser,
  }) => {
    const page = await signedIn(browser, LOGINS.A.admin, "admin");
    for (const key of lessonKeys) {
      const path = `/admin/lessons/${ids.lessons[key]}`;
      const { status, body } = await serverResponse(page, path);
      expect(status, path).toBe(200);
      expect(body, path).toContain(groupName(LESSONS[key].group));
      if ("log" in LESSONS[key])
        expect(body, path).toContain(logOf(key).content);
      for (const note of notesOn(key)) expect(body, path).toContain(note);
    }
    const notes = await callAction(
      page,
      [ADMIN_ACTIONS, "loadEarlierNotesAction"],
      [ids.lessons.colleagues, 0],
    );
    expect(notes.result).toMatchObject({ ok: true });
    expect(JSON.stringify(notes.result)).toContain(noteBody("aboutStudent"));
  });

  test("an admin can't write logs, homework or notes", async ({ browser }) => {
    await compileLessonActions(browser);
    const page = await signedIn(browser, LOGINS.A.admin, "admin");
    const before = await records();
    for (const key of ["substituted", "colleagues"] as const) {
      for (const c of teacherLessonCases({
        lesson: ids.lessons[key],
        teacherNote: ids.notes.aboutGroup,
        student: ids.student,
      })) {
        const { status, result } = await callAction(page, c.action, c.args);
        expect(result, `${key}: ${c.name}`).toBeNull();
        expect(status, `${key}: ${c.name}`).not.toBe(200);
      }
    }
    expect(await records()).toEqual(before);
  });
});

test.describe("lesson records › across schools", () => {
  const bLeaks = () => [
    SECOND_NAMES.group,
    SECOND_NAMES.lessonLog,
    SECOND_NAMES.homework,
    SECOND_NAMES.teacherNote,
  ];
  const aLeaks = () => [
    ...logMarkers("substituted"),
    ...allNoteBodies(),
    groupName("joined"),
  ];

  test("school A's teacher can't read or change school B's lessons and notes", async ({
    browser,
  }) => {
    await compileLessonActions(browser);
    const page = await signedIn(browser, LOGINS.A.teacher, "teacher");
    const before = await schoolFingerprint(b.school);
    await expectNotFound(page, `/teacher/lessons/${b.lesson}`, bLeaks());
    for (const filter of ["noLog", "past", "upcoming"]) {
      const path = `/teacher/lessons?filter=${filter}&term=${b.term}&group=${b.group}&teacher=${b.teacher}`;
      const { status, body } = await serverResponse(page, path);
      expect(status, path).toBe(200);
      expectNoneOf(body, bLeaks(), path);
    }
    for (const c of teacherLessonCases(b)) {
      const { status, result, body } = await callAction(page, c.action, c.args);
      expect(status, c.name).toBe(200);
      expect(result, c.name).toMatchObject(NOT_FOUND);
      expectNoneOf(body, bLeaks(), c.name);
    }
    expect(await schoolFingerprint(b.school)).toEqual(before);
  });

  test("school B's teacher can't read or change school A's lessons and notes", async ({
    browser,
  }) => {
    const page = await signedIn(browser, LOGINS.B.teacher, "teacher");
    const before = await records();
    await expectNotFound(
      page,
      `/teacher/lessons/${ids.lessons.substituted}`,
      aLeaks(),
    );
    for (const c of teacherLessonCases({
      lesson: ids.lessons.substituted,
      teacherNote: ids.notes.demoTeachers,
      student: ids.student,
    })) {
      const { result, body } = await callAction(page, c.action, c.args);
      expect(result, c.name).toMatchObject(NOT_FOUND);
      expectNoneOf(body, aLeaks(), c.name);
    }
    expect(await records()).toEqual(before);
  });

  test("an admin sees only their own school's lessons", async ({ browser }) => {
    const pageA = await signedIn(browser, LOGINS.A.admin, "admin");
    await expectNotFound(pageA, `/admin/lessons/${b.lesson}`, bLeaks());
    for (const filter of ["noLog", "past", "upcoming"]) {
      for (const path of [
        `/admin/lessons?filter=${filter}`,
        `/admin/lessons?filter=${filter}&term=${b.term}&group=${b.group}&teacher=${b.teacher}`,
      ]) {
        const { status, body } = await serverResponse(pageA, path);
        expect(status, path).toBe(200);
        expectNoneOf(body, bLeaks(), path);
      }
    }
    const notesA = await callAction(
      pageA,
      [ADMIN_ACTIONS, "loadEarlierNotesAction"],
      [b.lesson, 0],
    );
    expect(notesA.result).toMatchObject(NOT_FOUND);

    const pageB = await signedIn(browser, LOGINS.B.admin, "admin");
    const own = await serverResponse(pageB, `/admin/lessons/${b.lesson}`);
    expect(own.body).toContain(SECOND_NAMES.lessonLog);
    await expectNotFound(
      pageB,
      `/admin/lessons/${ids.lessons.substituted}`,
      aLeaks(),
    );
    for (const filter of ["noLog", "past", "upcoming"]) {
      const path = `/admin/lessons?filter=${filter}&term=${ids.term}&group=${ids.groups.joined}`;
      const { body } = await serverResponse(pageB, path);
      expectNoneOf(body, aLeaks(), path);
    }
    const notesB = await callAction(
      pageB,
      [ADMIN_ACTIONS, "loadEarlierNotesAction"],
      [ids.lessons.colleagues, 0],
    );
    expect(notesB.result).toMatchObject(NOT_FOUND);
    expectNoneOf(notesB.body, aLeaks(), "loadEarlierNotesAction");
  });

  test("a student opens only their own school's lessons", async ({
    browser,
  }) => {
    const pageA = await signedIn(browser, LOGINS.A.student, "student");
    await expectNotFound(pageA, `/student/lessons/${b.lesson}`, bLeaks());
    const homework = await serverResponse(
      pageA,
      `/student/homework?shown=1000&group=${b.group}`,
    );
    expectNoneOf(homework.body, bLeaks(), "/student/homework");

    const pageB = await signedIn(browser, LOGINS.B.student, "student");
    // Control: Bianca reads her own lesson's log, never the note about her.
    const own = await serverResponse(pageB, `/student/lessons/${b.lesson}`);
    expect(own.status).toBe(200);
    expect(own.body).toContain(SECOND_NAMES.lessonLog);
    expectNoneOf(own.body, [SECOND_NAMES.teacherNote], "own lesson");
    for (const key of ["substituted", "colleagues"] as const) {
      await expectNotFound(
        pageB,
        `/student/lessons/${ids.lessons[key]}`,
        aLeaks(),
      );
    }
    for (const path of ["/student", "/student/homework?shown=1000"]) {
      const { body } = await serverResponse(pageB, path);
      expectNoneOf(body, aLeaks(), path);
    }
  });
});
