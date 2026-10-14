import "dotenv/config";

import { expect, type Page } from "@playwright/test";
import { Client } from "pg";

import { DEMO_LOGINS, DEMO_PASSWORD } from "../prisma/seed/data";
import { addDays } from "../src/server/scheduling/time";

export { DEMO_LOGINS, DEMO_PASSWORD };

export async function signIn(
  page: Page,
  email: string,
  password = DEMO_PASSWORD,
) {
  if (!page.url().includes("/login")) await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export async function expectDashboard(page: Page, path: string) {
  await expect(page).toHaveURL(path);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /^(Good (morning|afternoon|evening)|Hi), /,
  );
}

/** Runs SQL against the test database (fixtures the seed doesn't cover). */
export async function sql<T = unknown>(
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(query, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/**
 * The published term of `schoolId` running on `today` — the seeded one
 * while it lasts. A school's terms never overlap, so specs that need
 * lessons around today put them in this term instead of adding their own
 * (and leave it in place). When no term covers today, an "E2E current term"
 * fills the gap between its neighbours; parallel workers insert it once
 * (`ON CONFLICT DO NOTHING` also covers the exclusion constraint).
 * `through` is the last date the spec's lessons need inside the term.
 */
export async function currentTermId(
  schoolId: string,
  today: string,
  through: string,
): Promise<string> {
  const find = () =>
    sql<{ id: string; end: string; published: boolean }>(
      `SELECT id, to_char(end_date, 'YYYY-MM-DD') AS end,
              timetable_published_at IS NOT NULL AS published
       FROM terms WHERE school_id = $1 AND start_date <= $2 AND $2 <= end_date`,
      [schoolId, today],
    );
  let [term] = await find();
  if (!term) {
    await sql(
      `INSERT INTO terms (id, school_id, name, start_date, end_date, timetable_published_at, updated_at)
       SELECT gen_random_uuid(), $1, 'E2E current term ' || $2,
              GREATEST($2::date - 60, (SELECT max(end_date) + 1 FROM terms
                                       WHERE school_id = $1 AND end_date < $2::date)),
              LEAST($2::date + 60, (SELECT min(start_date) - 1 FROM terms
                                    WHERE school_id = $1 AND start_date > $2::date)),
              now(), now()
       ON CONFLICT DO NOTHING`,
      [schoolId, today],
    );
    [term] = await find();
  }
  if (!term?.published || term.end < through) {
    throw new Error(
      `No published term covers ${today} – ${through}; re-seed or move the spec's dates.`,
    );
  }
  return term.id;
}

/**
 * Inserts a spec's own term of `days` days from `startDate`. A school's
 * terms never overlap, so when those dates are taken (the same spec's
 * `beforeAll` in another worker, a crashed run's leftover) it moves on by
 * whole weeks — weekdays stay put — until it fits. Returns the dates used.
 */
export async function insertOwnTerm(term: {
  id: string;
  schoolId: string;
  name: string;
  startDate: string;
  days: number;
  published: boolean;
}): Promise<{ startDate: string; endDate: string }> {
  const step = Math.ceil(term.days / 7) * 7;
  for (let attempt = 0; attempt < 20; attempt++) {
    const startDate = addDays(term.startDate, attempt * step);
    const endDate = addDays(startDate, term.days - 1);
    try {
      await sql(
        `INSERT INTO terms (id, school_id, name, start_date, end_date, timetable_published_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END, now())`,
        [term.id, term.schoolId, term.name, startDate, endDate, term.published],
      );
      return { startDate, endDate };
    } catch (error) {
      if ((error as { code?: string }).code !== "23P01") throw error;
    }
  }
  throw new Error(`No free dates for term ${term.name}`);
}
