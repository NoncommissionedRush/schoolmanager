// Concurrent queries on one connection against a real Postgres. Opt-in, like
// the other DB tests: set SCHEDULING_TEST_DATABASE_URL to a migrated database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

import { createPgAdapter, SerialClient } from "./pg-adapter";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
const QUEUED = "already executing a query";

describe.skipIf(!url)("serial pg client (database)", () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => warnings.push(warning.message);

  beforeAll(() => {
    process.on("warning", onWarning);
  });
  afterAll(() => {
    process.off("warning", onWarning);
  });

  it("runs overlapping queries in order without queueing in pg", async () => {
    const client = new SerialClient({ connectionString: url });
    await client.connect();
    try {
      const results = await Promise.all(
        [3, 1, 2].map((n) =>
          client.query("SELECT pg_sleep($1::int / 100.0), $1::int AS n", [n]),
        ),
      );
      expect(results.map((r) => r.rows[0].n)).toEqual([3, 1, 2]);
    } finally {
      await client.end();
    }
    expect(warnings.filter((w) => w.includes(QUEUED))).toEqual([]);
  });

  it("keeps going after a failed query", async () => {
    const client = new SerialClient({ connectionString: url });
    await client.connect();
    try {
      const [failed, ok] = await Promise.allSettled([
        client.query("SELECT * FROM no_such_table"),
        client.query("SELECT 1 AS one"),
      ]);
      expect(failed.status).toBe("rejected");
      expect(ok.status === "fulfilled" && ok.value.rows[0].one).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("lets Prisma run parallel reads inside a transaction quietly", async () => {
    const db = new PrismaClient({ adapter: createPgAdapter(url) });
    try {
      const counts = await db.$transaction((tx) =>
        Promise.all([tx.school.count(), tx.user.count(), tx.school.count()]),
      );
      expect(counts).toHaveLength(3);
    } finally {
      await db.$disconnect();
    }
    expect(warnings.filter((w) => w.includes(QUEUED))).toEqual([]);
  });
});
