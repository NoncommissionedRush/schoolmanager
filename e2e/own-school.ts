import { randomUUID } from "node:crypto";

import { hashPassword } from "../src/server/auth/password";
import { DEMO_PASSWORD, sql } from "./helpers";

/**
 * A school of the spec's own, with one admin, for specs that change
 * school-wide lists (levels, terms, …). Other specs digest or count the demo
 * school's rows in parallel; writes here can't reach them, and their writes
 * can't reorder or crowd what this spec asserts on.
 */
export async function createOwnSchool(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const school = {
    id: randomUUID(),
    name: `E2E ${label} ${suffix}`,
    adminUser: randomUUID(),
    adminEmail: `e2e-${label.toLowerCase().replace(/\W+/g, "-")}-${suffix}@example.test`,
  };
  await sql(
    `INSERT INTO schools (id, name, slug, timezone, updated_at)
     VALUES ($1, $2, $3, 'Europe/Bratislava', now())`,
    [school.id, school.name, `e2e-${suffix}`],
  );
  await sql(
    `INSERT INTO users (id, email, name, password_hash, updated_at)
     VALUES ($1, $2, 'E2E Admin', $3, now())`,
    [school.adminUser, school.adminEmail, await hashPassword(DEMO_PASSWORD)],
  );
  await sql(
    `INSERT INTO memberships (id, school_id, user_id, role, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'ADMIN', now())`,
    [school.id, school.adminUser],
  );
  return school;
}

/** Removes a school with all its rows and its members' users. */
export async function removeSchool(schoolId: string) {
  const members = await sql<{ user_id: string }>(
    "SELECT user_id FROM memberships WHERE school_id = $1",
    [schoolId],
  );
  const tables = (
    await sql<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND column_name = 'school_id'`,
    )
  ).map((r) => r.table_name);
  // Restrict FKs between tenant tables: retry until every table is empty.
  for (let pass = 0; pass < 10; pass++) {
    let blocked = 0;
    for (const table of tables) {
      try {
        await sql(`DELETE FROM ${table} WHERE school_id = $1`, [schoolId]);
      } catch {
        blocked++;
      }
    }
    if (!blocked) break;
  }
  await sql("DELETE FROM schools WHERE id = $1", [schoolId]);
  // Users who belong to no other school (the spec's own people).
  await sql(
    `DELETE FROM users u WHERE u.id = ANY($1)
     AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)`,
    [members.map((m) => m.user_id)],
  );
}
