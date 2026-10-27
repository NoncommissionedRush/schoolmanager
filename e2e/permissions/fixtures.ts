import { type Browser, expect, type Page } from "@playwright/test";

import { SECOND_LOGINS, SECOND_NAMES } from "../../prisma/seed/second-school";
import { seedDate } from "../clock";
import { DEMO_LOGINS, signIn, sql } from "../helpers";

export { SECOND_LOGINS, SECOND_NAMES };

// Shared fixtures for the permission suite. School A is the demo school,
// school B the small second school from prisma/seed/second-school.ts.

export const SCHOOL_A = "demo-language-school";
export const SCHOOL_B = "northbridge-language-academy";

/** A week with lessons in both schools' published terms (seed DEMO_TODAY). */
export const WEEK = seedDate("2026-10-12");

export const LOGINS = {
  A: DEMO_LOGINS,
  B: SECOND_LOGINS,
} as const;

export type Role = "admin" | "teacher" | "student";
const HOME: Record<Role, string> = {
  admin: "/admin",
  teacher: "/teacher",
  student: "/student",
};

/** A fresh, signed-in page for `email` (own browser context, own cookies). */
export async function signedIn(browser: Browser, email: string, role: Role) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  await page.waitForURL(HOME[role]);
  return page;
}

const SEEDED = "id::text LIKE '________-____-5%'";

/** Ids of one school's entities, as an attacker might guess or harvest them. */
export type SchoolIds = Awaited<ReturnType<typeof schoolIds>>;

/**
 * Ids of a representative entity of each kind in a school: the role logins'
 * own users and profiles, and a seeded group, room, level, … of the school.
 */
export async function schoolIds(slug: string) {
  const one = async (query: string, params: unknown[]) => {
    const [row] = await sql<{ id: string }>(query, params);
    if (!row) throw new Error(`Fixture missing in ${slug}: ${query}`);
    return row.id;
  };
  const school = await one("SELECT id FROM schools WHERE slug = $1", [slug]);
  const logins = slug === SCHOOL_A ? LOGINS.A : LOGINS.B;
  const userOf = (email: string) =>
    one("SELECT id FROM users WHERE email = $1", [email]);
  // Seeded rows only (their ids are v5 UUIDs, see prisma/seed/ids.ts):
  // other specs create and delete rows of their own while this one runs.
  const first = (table: string, extra = "") =>
    one(
      `SELECT id FROM ${table} WHERE school_id = $1 AND ${SEEDED} ${extra}
       ORDER BY id LIMIT 1`,
      [school],
    );

  const teacherUser = await userOf(logins.teacher);
  const studentUser = await userOf(logins.student);
  const teacher = await one(
    "SELECT id FROM teacher_profiles WHERE school_id = $1 AND user_id = $2",
    [school, teacherUser],
  );
  const student = await one(
    "SELECT id FROM student_profiles WHERE school_id = $1 AND user_id = $2",
    [school, studentUser],
  );
  const groupMembership = await one(
    `SELECT id FROM group_memberships
     WHERE school_id = $1 AND student_id = $2 AND ${SEEDED} ORDER BY id LIMIT 1`,
    [school, student],
  );
  const group = await one(
    "SELECT group_id AS id FROM group_memberships WHERE id = $1",
    [groupMembership],
  );
  const slot = await one(
    `SELECT id FROM timetable_slots
     WHERE school_id = $1 AND group_id = $2 AND ${SEEDED} ORDER BY id LIMIT 1`,
    [school, group],
  );
  return {
    school,
    adminUser: await userOf(logins.admin),
    teacherUser,
    studentUser,
    teacher,
    student,
    group,
    groupMembership,
    slot,
    term: await one("SELECT term_id AS id FROM timetable_slots WHERE id = $1", [
      slot,
    ]),
    lesson: await one(
      `SELECT id FROM lessons
       WHERE school_id = $1 AND group_id = $2 AND ${SEEDED} ORDER BY starts_at LIMIT 1`,
      [school, group],
    ),
    room: await first("rooms", "AND archived_at IS NULL"),
    level: await first("levels", "AND archived_at IS NULL"),
    course: await first("courses"),
    holiday: await first("holidays"),
    availability: await first("teacher_availability"),
    teacherNote: await first("teacher_notes"),
    absence: await first("absence_reports"),
    replacement: await first("replacement_requests"),
    credit: await first("makeup_credits"),
  };
}

/** Every table with a `school_id` column (all tenant-owned data). */
async function tenantTables(): Promise<string[]> {
  const rows = await sql<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND column_name = 'school_id'
     ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

/**
 * Rows as compared by `schoolFingerprint`, where the app legitimately
 * rewrites them on reads. Loading /admin/absences or /student/absences runs
 * `expireCredits` for the viewer's school, which stores AVAILABLE -> EXPIRED
 * (and bumps updated_at) for credits past expiry; specs running in parallel
 * load school B's lists at any time (CARM-82). So credits are compared by
 * their effective state (`creditState`), without updated_at: the sweep
 * changes nothing, every other write still does.
 */
const ROW_TEXT: Record<string, string> = {
  makeup_credits: `(to_jsonb(t) - 'updated_at' || jsonb_build_object('status',
    CASE WHEN t.status = 'AVAILABLE' AND t.expires_at <= now()
      THEN 'EXPIRED' ELSE t.status::text END))::text`,
};

/**
 * A digest of everything a school owns: each tenant table's rows, the
 * school row and its members' user rows (passwords, archive state). Equal
 * before and after means nothing in the school changed.
 */
export async function schoolFingerprint(
  schoolId: string,
): Promise<Record<string, string>> {
  const digest: Record<string, string> = {};
  for (const table of await tenantTables()) {
    const [row] = await sql<{ digest: string | null }>(
      `SELECT md5(string_agg(${ROW_TEXT[table] ?? "t::text"}, '|' ORDER BY t.id)) AS digest
       FROM ${table} t WHERE school_id = $1`,
      [schoolId],
    );
    digest[table] = row.digest ?? "empty";
  }
  const [school] = await sql<{ digest: string }>(
    "SELECT md5(s::text) AS digest FROM schools s WHERE id = $1",
    [schoolId],
  );
  const [users] = await sql<{ digest: string }>(
    `SELECT md5(string_agg(u::text, '|' ORDER BY u.id)) AS digest
     FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.school_id = $1`,
    [schoolId],
  );
  digest.schools = school.digest;
  digest.users = users.digest;
  return digest;
}

/**
 * The page's server response as text: the HTML plus the inlined RSC
 * payload, so leak checks also see data the UI receives but doesn't render.
 */
export async function serverResponse(page: Page, url: string) {
  const response = await page.request.get(url, {
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  return { status: response.status(), body: await response.text() };
}

/**
 * Whether a server response is Next's "not found". Inside a streamed page
 * the status stays 200, and the "Page not found" copy is inlined in every
 * page's RSC payload (the not-found boundary), so only the error digest
 * tells them apart.
 */
export function isNotFound(body: string) {
  return body.includes("NEXT_HTTP_ERROR_FALLBACK;404");
}

/**
 * Asserts that none of `needles` occurs anywhere in `body`, also after
 * undoing HTML entities and the JSON escaping of the inlined RSC payload.
 */
export function expectNoneOf(body: string, needles: string[], where: string) {
  const decoded = body
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\+(["'\\/])/g, "$1");
  const found = needles.filter((n) => body.includes(n) || decoded.includes(n));
  expect(found, `leaked into ${where}`).toEqual([]);
}
