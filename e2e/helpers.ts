import "dotenv/config";

import { expect, type Page } from "@playwright/test";
import { Client } from "pg";

import { DEMO_LOGINS, DEMO_PASSWORD } from "../prisma/seed/data";

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
