import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3000);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // CI runs against a production build; locally reuse `pnpm dev` if running.
    command: process.env.CI
      ? `pnpm start --port ${PORT}`
      : `pnpm dev --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Auth.js refuses to start without a secret. CI has no `.env`, so fall
      // back to a test-only value; a real AUTH_SECRET always wins.
      AUTH_SECRET:
        process.env.AUTH_SECRET ??
        "e2e-only-secret-not-for-production-0123456789",
      // Calendar links (phase5-rules.md §5.1) need a signing secret too.
      ICAL_TOKEN_SECRET:
        process.env.ICAL_TOKEN_SECRET ??
        "e2e-only-ical-secret-not-for-production-0123456789",
    },
  },
});
