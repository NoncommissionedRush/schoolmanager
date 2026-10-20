import "dotenv/config";

import { BASE_TERM_START, BASE_TODAY } from "../prisma/seed/clock";
import {
  addDays,
  daysBetween,
  toZonedDateTime,
} from "../src/server/scheduling/time";
import { NOW_ENV, SEED_SHIFT_ENV, TZ } from "./clock";
import { sql } from "./helpers";

/**
 * Pins the run's reference time for every worker (e2e/clock.ts) and reads
 * the week the demo data was seeded for, so fixtures line up with the seed
 * and with each other on whatever day the suite runs.
 */
export default async function globalSetup() {
  const start = new Date();
  process.env[NOW_ENV] = start.toISOString();
  const today = toZonedDateTime(start, TZ).date;

  const [term] = await sql<{ start: string }>(
    `SELECT to_char(t.start_date, 'YYYY-MM-DD') AS start
     FROM terms t JOIN schools s ON s.id = t.school_id
     WHERE s.slug = 'demo-language-school' AND t.name = 'Autumn 2026'`,
  );
  if (!term) {
    throw new Error("No demo data: run `pnpm db:seed` before the e2e suite.");
  }
  const shift = daysBetween(BASE_TERM_START, term.start);
  const seedToday = addDays(BASE_TODAY, shift);
  // The seed's "today" is the latest Wednesday on or before the day it ran
  // (prisma/seed/clock.ts). A week later its upcoming lessons and bookings
  // start to lie in the past: the CARM-81 kind of failure.
  if (seedToday > today || daysBetween(seedToday, today) >= 7) {
    throw new Error(
      `The demo data was seeded for the week of ${seedToday}, but today is ` +
        `${today}. Re-seed a fresh database (\`pnpm db:reset\`) and run again.`,
    );
  }
  process.env[SEED_SHIFT_ENV] = String(shift);
}
