// Deletes every notification older than the retention window, in every
// school (docs/architecture/phase5-rules.md §2.5). The inbox also purges a
// user's own expired rows when they open it; this covers users who never
// do. Run with `pnpm notifications:purge`.
import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import {
  NOTIFICATION_RETENTION_DAYS,
  retentionCutoff,
} from "../src/server/notifications/rules";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const { count } = await db.notification.deleteMany({
      where: { createdAt: { lte: retentionCutoff(new Date()) } },
    });
    console.log(
      `Deleted ${count} notifications older than ${NOTIFICATION_RETENTION_DAYS} days.`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
