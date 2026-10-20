import { addDays, toZonedDateTime } from "../src/server/scheduling/time";

// The e2e suite's only access to the wall clock: eslint bans `Date.now()`
// and `new Date()` everywhere else in e2e/. The app runs on the real clock,
// so fixtures are placed relative to it in one of two ways:
// - days relative to TODAY, the run's reference day, which every worker
//   shares (set once in global-setup.ts);
// - seeded data through `seedDate`, which follows the week the database
//   was seeded for (prisma/seed/clock.ts).

export const NOW_ENV = "E2E_NOW";
export const SEED_SHIFT_ENV = "E2E_SEED_SHIFT_DAYS";

/** Time zone of the demo schools (and of the specs' own schools). */
export const TZ = "Europe/Bratislava";

/**
 * A value global-setup.ts passes to the workers. Playwright also loads the
 * spec files in its main process to list the tests, where it isn't set yet;
 * nothing runs there, so a placeholder will do.
 */
function fromSetup(name: string, placeholder: string): string {
  const value = process.env[name];
  if (value !== undefined) return value;
  if (process.env.TEST_WORKER_INDEX !== undefined) {
    throw new Error(`${name} is unset: e2e/global-setup.ts didn't run.`);
  }
  return placeholder;
}

/** The current instant, for "an hour ago" or "in two hours" fixtures. */
export function currentTime(): Date {
  return new Date(Date.now());
}

/** When the run started: the same instant in every worker. */
export const RUN_START = new Date(
  fromSetup(NOW_ENV, new Date(0).toISOString()),
);

/** Today in TZ when the run started. */
export const TODAY = toZonedDateTime(RUN_START, TZ).date;

/**
 * A date of the seed as written in prisma/seed (around 2026-10-14), moved to
 * the week the database was seeded for.
 */
export function seedDate(isoDate: string): string {
  return addDays(isoDate, Number(fromSetup(SEED_SHIFT_ENV, "0")));
}
