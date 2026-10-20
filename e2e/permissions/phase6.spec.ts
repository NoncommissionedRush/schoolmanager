import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
import { pagesIn, PLACEHOLDER_ID, serverActionsIn } from "../server-actions";
import {
  expectNoneOf,
  isNotFound,
  type Role,
  schoolFingerprint,
  serverResponse,
  signedIn,
} from "./fixtures";

// Phase 6 permissions (CARM-74): the attendance and teacher-hours reports,
// one teacher's lessons and their CSV exports
// (docs/architecture/phase6-rules.md). Admins of the school only:
//
// - Pages: signed out → login, teacher or student → 403, another school's
//   ids (as the teacher page or a filter) → "not found".
// - Exports (`/api/admin/reports/<report>.csv`): signed out → 401, teacher
//   or student → 403, another school's ids → 404, all with an empty body.
//   Only a delivered export is audited, in the exporting admin's school.
//
// Two schools of its own, created and removed here: "C" and "D", the other
// tenant. Exports write audit rows, so nothing here touches the seeded
// schools.
//
// - C: Tilda teaches "group" (two ended lessons, one ahead), Stella is in
//   it and reported one absence. Colm teaches nothing. Demi is an admin
//   who gets demoted with a live session.
// - D: Dex teaches Dina (one ended lesson).

const TZ = "Europe/Bratislava";
const FORBIDDEN = "You don't have access to this page";

const suffix = randomUUID().slice(0, 8);
const today = toZonedDateTime(new Date(), TZ).date;

type Who =
  | "admin"
  | "demoted"
  | "teacher"
  | "colleague"
  | "student"
  | "adminD"
  | "teacherD"
  | "studentD";

const PEOPLE: Record<Who, { school: "C" | "D"; role: Role; name: string }> = {
  admin: { school: "C", role: "admin", name: `Ada P6 ${suffix}` },
  demoted: { school: "C", role: "admin", name: `Demi P6 ${suffix}` },
  teacher: { school: "C", role: "teacher", name: `Tilda P6 ${suffix}` },
  colleague: { school: "C", role: "teacher", name: `Colm P6 ${suffix}` },
  student: { school: "C", role: "student", name: `Stella P6 ${suffix}` },
  adminD: { school: "D", role: "admin", name: `Dora P6 ${suffix}` },
  teacherD: { school: "D", role: "teacher", name: `Dex P6 ${suffix}` },
  studentD: { school: "D", role: "student", name: `Dina P6 ${suffix}` },
};
const EVERYONE = Object.keys(PEOPLE) as Who[];
const emailOf = (who: Who) =>
  `e2e-p6-${who.toLowerCase()}-${suffix}@phase6.test`;

const NAMES = {
  schoolC: `E2E Phase6 C ${suffix}`,
  schoolD: `E2E Phase6 D ${suffix}`,
  group: `P6 Group ${suffix}`,
  groupD: `P6 Group D ${suffix}`,
};

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
  groupD: randomUUID(),
};

const LESSONS = {
  group: [-7, -3, 4].map((d) => ({
    id: randomUUID(),
    date: addDays(today, d),
  })),
  groupD: [-3].map((d) => ({ id: randomUUID(), date: addDays(today, d) })),
};

/** A school's ids, as filters and the teacher page take them. */
type Target = { term: string; teacher: string; group: string; student: string };
const C: Target = {
  term: ids.termC,
  teacher: ids.profiles.teacher,
  group: ids.group,
  student: ids.profiles.student,
};
const D: Target = {
  term: ids.termD,
  teacher: ids.profiles.teacherD,
  group: ids.groupD,
  student: ids.profiles.studentD,
};

/** Every report page (src/app/admin/reports/**), aimed at `t`. */
const reportPages = (t: Target) => [
  "/admin/reports",
  "/admin/reports/attendance",
  "/admin/reports/teacher-hours",
  `/admin/reports/teacher-hours/${t.teacher}`,
];

/** Every CSV export (`REPORTS` in src/server/reports/rules.ts), aimed at `t`. */
const exportsOf = (t: Target) => [
  "/api/admin/reports/attendance.csv",
  "/api/admin/reports/teacher-hours.csv",
  `/api/admin/reports/teacher-hours-lessons.csv?teacher=${t.teacher}`,
];

/** Each filter of a report set to one of `t`'s ids, one at a time. */
const filtered = (path: string, t: Target) =>
  (["term", "teacher", "group", "student"] as const).map((key) => {
    const url = new URL(path, "http://x");
    url.searchParams.set(key, t[key]);
    return `${url.pathname}${url.search}`;
  });

/** School C's names, none of which may reach anyone but C's admins. */
const C_SECRETS = [
  NAMES.schoolC,
  NAMES.group,
  PEOPLE.teacher.name,
  PEOPLE.colleague.name,
  PEOPLE.student.name,
];
const D_SECRETS = [
  NAMES.schoolD,
  NAMES.groupD,
  PEOPLE.teacherD.name,
  PEOPLE.studentD.name,
];

/** The audit rows of delivered exports in a school. */
const exportsAudited = async (schoolId: string) => {
  const [row] = await sql<{ count: string }>(
    `SELECT count(*) FROM audit_logs
     WHERE school_id = $1 AND action = 'report.exported'`,
    [schoolId],
  );
  return Number(row.count);
};

test.describe("phase 6 permissions", () => {
  test.describe.configure({ mode: "serial" });

  let browserRef: Browser;
  /** No session. */
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
        [id, name, `e2e-phase6-${slug}-${suffix}`, TZ],
      );
    }
    await sql(
      `INSERT INTO levels (id, school_id, code, name, rank, updated_at)
       VALUES ($1, $2, 'P6', 'Phase 6', 1, now()), ($3, $4, 'P6', 'Phase 6', 1, now())`,
      [ids.levelC, ids.schoolC, ids.levelD, ids.schoolD],
    );
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
          `P6 Term ${suffix}`,
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
      }
      if (role === "student") {
        await sql(
          `INSERT INTO student_profiles (id, school_id, user_id, level_id, updated_at)
           VALUES ($1, $2, $3, $4, now())`,
          [ids.profiles[who], school, ids.users[who], level],
        );
      }
    }
    const since = zonedTimeToUtc(addDays(today, -40), 0, TZ);
    for (const [
      group,
      school,
      level,
      term,
      name,
      teacher,
      student,
      lessons,
    ] of [
      [
        ids.group,
        ids.schoolC,
        ids.levelC,
        ids.termC,
        NAMES.group,
        "teacher",
        "student",
        LESSONS.group,
      ],
      [
        ids.groupD,
        ids.schoolD,
        ids.levelD,
        ids.termD,
        NAMES.groupD,
        "teacherD",
        "studentD",
        LESSONS.groupD,
      ],
    ] as const) {
      await sql(
        `INSERT INTO groups (id, school_id, level_id, type, name, capacity, updated_at)
         VALUES ($1, $2, $3, 'GROUP', $4, 8, now())`,
        [group, school, level, name],
      );
      await sql(
        `INSERT INTO group_memberships (id, school_id, group_id, student_id, joined_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
        [school, group, ids.profiles[student], since],
      );
      for (const lesson of lessons) {
        await sql(
          `INSERT INTO lessons (id, school_id, term_id, group_id, teacher_id, starts_at, ends_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '45 minutes', now())`,
          [
            lesson.id,
            school,
            term,
            group,
            ids.profiles[teacher],
            zonedTimeToUtc(lesson.date, 6 * 60, TZ),
          ],
        );
      }
    }
    await sql(
      `INSERT INTO absence_reports (id, school_id, lesson_id, student_id, reported_by_id, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
      [
        ids.schoolC,
        LESSONS.group[0].id,
        ids.profiles.student,
        ids.users.student,
      ],
    );
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

  test("the cases cover every Phase 6 page, action and export", () => {
    // Pages: every page.tsx under /admin/reports is checked below.
    expect(
      reportPages(C)
        .map((path) => path.replace(C.teacher, PLACEHOLDER_ID))
        .sort(),
    ).toEqual(pagesIn("src/app/admin/reports").sort());

    // Actions: the reports have none. A new one needs cases here.
    expect([
      ...serverActionsIn("src/app/admin/reports"),
      ...serverActionsIn("src/components/reports"),
      ...serverActionsIn("src/server/reports"),
    ]).toEqual([]);

    // Exports: one per report kind, served by the one admin API route.
    const routes = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const child = join(dir, name);
        if (statSync(child).isDirectory()) return routes(child);
        return name === "route.ts" ? [child] : [];
      });
    expect(routes("src/app/api/admin")).toEqual([
      "src/app/api/admin/reports/[report]/route.ts",
    ]);
    const kinds = /export const REPORTS = \[([^\]]*)\]/.exec(
      readFileSync("src/server/reports/rules.ts", "utf8"),
    )![1];
    const reports = [...kinds.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(reports.length).toBeGreaterThan(0);
    expect(
      exportsOf(C)
        .map((path) => /\/([^/?]+)\.csv/.exec(path)![1])
        .sort(),
    ).toEqual(reports.sort());
  });

  test("signed out, the pages send to login and the exports answer 401", async () => {
    for (const path of [
      ...reportPages(C),
      ...filtered("/admin/reports/attendance", C),
    ]) {
      const response = await anonymous.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBeGreaterThanOrEqual(300);
      expect(response.status(), path).toBeLessThan(400);
      expect(response.headers().location, path).toContain("/login");
    }
    for (const path of [
      ...exportsOf(C),
      ...filtered("/api/admin/reports/attendance.csv", C),
    ]) {
      const response = await anonymous.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(401);
      expect(await response.text(), path).toBe("");
    }
    expect(await exportsAudited(ids.schoolC)).toBe(0);
  });

  for (const who of ["teacher", "colleague", "student"] as const) {
    test(`a ${who} can't open the reports or export them`, async () => {
      const page = await as(who);
      const secrets = C_SECRETS.filter((s) => s !== PEOPLE[who].name);
      const before = await schoolFingerprint(ids.schoolC);

      for (const path of [
        ...reportPages(C),
        ...filtered("/admin/reports/attendance", C),
        ...filtered("/admin/reports/teacher-hours", C),
      ]) {
        const response = await serverResponse(page, path);
        expect(response.status, path).toBe(403);
        expect(response.body, path).toContain("have access to this page");
        expectNoneOf(response.body, secrets, path);
      }
      for (const path of reportPages(C)) {
        await page.goto(path);
        await expect(
          page.getByRole("heading", { name: FORBIDDEN }),
          path,
        ).toBeVisible();
      }

      for (const path of [
        ...exportsOf(C),
        ...filtered("/api/admin/reports/attendance.csv", C),
        ...filtered("/api/admin/reports/teacher-hours.csv", C),
      ]) {
        const response = await page.request.get(path, { maxRedirects: 0 });
        expect(response.status(), path).toBe(403);
        expect(await response.text(), path).toBe("");
      }
      expect(await schoolFingerprint(ids.schoolC)).toEqual(before);
    });
  }

  test("the school's admin reads and exports its own reports only", async () => {
    const page = await as("admin");
    for (const path of reportPages(C)) {
      const { status, body } = await serverResponse(page, path);
      expect(status, path).toBe(200);
      expect(isNotFound(body), path).toBe(false);
      expectNoneOf(body, D_SECRETS, path);
    }
    const attendance = await serverResponse(page, "/admin/reports/attendance");
    expect(attendance.body).toContain(PEOPLE.student.name);

    const before = await exportsAudited(ids.schoolC);
    const delivered = [];
    for (const path of exportsOf(C)) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()["content-type"], path).toContain("text/csv");
      const csv = await response.text();
      expectNoneOf(csv, D_SECRETS, path);
      delivered.push(csv);
    }
    expect(delivered[0]).toContain(PEOPLE.student.name);
    expect(delivered[1]).toContain(PEOPLE.teacher.name);
    expect(delivered[2]).toContain(NAMES.group);
    expect(await exportsAudited(ids.schoolC)).toBe(before + 3);
    expect(await exportsAudited(ids.schoolD)).toBe(0);
  });

  test("an admin of another school gets 'not found' for the school's ids", async () => {
    const page = await as("adminD");
    const beforeC = await schoolFingerprint(ids.schoolC);
    const auditedD = await exportsAudited(ids.schoolD);

    // Their own reports work and show nothing of school C.
    for (const path of reportPages(D)) {
      const { status, body } = await serverResponse(page, path);
      expect(status, path).toBe(200);
      expect(isNotFound(body), path).toBe(false);
      expectNoneOf(body, C_SECRETS, path);
    }
    const own = await serverResponse(page, "/admin/reports/attendance");
    expect(own.body).toContain(PEOPLE.studentD.name);

    // School C's ids: the teacher page and every filter are "not found".
    for (const path of [
      `/admin/reports/teacher-hours/${C.teacher}`,
      `/admin/reports/teacher-hours/${ids.users.teacher}`,
      ...filtered("/admin/reports/attendance", C),
      ...filtered("/admin/reports/teacher-hours", C),
      // The page's own teacher wins over a `teacher` filter.
      ...filtered(`/admin/reports/teacher-hours/${D.teacher}`, C).filter(
        (path) => !path.includes(`teacher=${C.teacher}`),
      ),
    ]) {
      const { body } = await serverResponse(page, path);
      expect(isNotFound(body), path).toBe(true);
      expectNoneOf(body, C_SECRETS, path);
    }
    await page.goto(`/admin/reports/teacher-hours/${C.teacher}`);
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();

    // The exports answer an empty 404 and audit nothing.
    for (const path of [
      `/api/admin/reports/teacher-hours-lessons.csv?teacher=${C.teacher}`,
      ...filtered("/api/admin/reports/attendance.csv", C),
      ...filtered("/api/admin/reports/teacher-hours.csv", C),
      ...filtered(
        `/api/admin/reports/teacher-hours-lessons.csv?teacher=${D.teacher}`,
        C,
      ),
    ]) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(404);
      expect(await response.text(), path).toBe("");
    }

    // Their own unfiltered exports have nothing of school C either.
    for (const path of exportsOf(D)) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(200);
      expectNoneOf(await response.text(), C_SECRETS, path);
    }
    expect(await exportsAudited(ids.schoolD)).toBe(auditedD + 3);
    expect(await schoolFingerprint(ids.schoolC)).toEqual(beforeC);
  });

  test("a demoted admin with a live session is refused", async () => {
    // The session token still says ADMIN, so the proxy lets the pages
    // through: the pages and the export route check the role in the DB.
    const page = await as("demoted");
    expect(
      (await page.request.get(exportsOf(C)[0])).status(),
      "still an admin",
    ).toBe(200);
    try {
      for (const role of ["TEACHER", "STUDENT"]) {
        await sql(
          `UPDATE memberships SET role = $2::"Role" WHERE user_id = $1`,
          [ids.users.demoted, role],
        );
        const before = await schoolFingerprint(ids.schoolC);
        for (const path of reportPages(C)) {
          // Past the proxy the page streams, so the status stays 200:
          // the forbidden boundary's digest tells the refusal apart.
          const { body } = await serverResponse(page, path);
          expect(body, `${role} ${path}`).toContain(
            "NEXT_HTTP_ERROR_FALLBACK;403",
          );
          expectNoneOf(body, C_SECRETS, `${role} ${path}`);
          await page.goto(path);
          await expect(
            page.getByRole("heading", { name: FORBIDDEN }),
            `${role} ${path}`,
          ).toBeVisible();
        }
        for (const path of exportsOf(C)) {
          const response = await page.request.get(path);
          expect(response.status(), `${role} ${path}`).toBe(403);
          expect(await response.text(), path).toBe("");
        }
        expect(await schoolFingerprint(ids.schoolC)).toEqual(before);
      }
    } finally {
      await sql(`UPDATE memberships SET role = 'ADMIN' WHERE user_id = $1`, [
        ids.users.demoted,
      ]);
    }
  });
});
