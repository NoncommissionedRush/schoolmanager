import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { toSchoolSlug } from "../src/server/schools";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const name = "Demo Language School";
  const school = await db.school.upsert({
    where: { slug: toSchoolSlug(name) },
    update: { name },
    create: { name, slug: toSchoolSlug(name) },
  });
  console.log(`Seeded school "${school.name}" (${school.id})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
