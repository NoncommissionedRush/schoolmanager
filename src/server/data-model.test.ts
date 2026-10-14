import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Guards the multi-tenancy invariants of prisma/schema.prisma: every
// tenant-owned model carries `schoolId`, and relations between tenant-owned
// models go through the composite `[schoolId, id]` key so rows can never
// reference another school's data.

const GLOBAL_MODELS = new Set([
  "School",
  "User",
  "Account",
  "VerificationToken",
]);

const schema = readFileSync(
  join(process.cwd(), "prisma/schema.prisma"),
  "utf8",
);
const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(
  ([, name, body]) => ({ name, body }),
);
const tenantModels = models.filter((m) => !GLOBAL_MODELS.has(m.name));
const tenantModelNames = new Set(tenantModels.map((m) => m.name));

describe("data model tenancy", () => {
  it("parses the schema", () => {
    expect(tenantModels.length).toBeGreaterThan(15);
  });

  it.each(tenantModels.map((m) => [m.name, m.body]))(
    "%s has a school_id column linked to School",
    (_name, body) => {
      expect(body).toMatch(/^\s+schoolId\s+String\s+@map\("school_id"\)/m);
      expect(body).toMatch(
        /^\s+school\s+School\s+@relation\(fields: \[schoolId\], references: \[id\]/m,
      );
    },
  );

  it.each(tenantModels.map((m) => [m.name, m.body]))(
    "%s references tenant-owned models only via [schoolId, id]",
    (_name, body) => {
      const relations = [
        ...body.matchAll(/^\s+\w+\s+(\w+)\??\s+@relation\(([^)]*)\)/gm),
      ];
      for (const [line, target, args] of relations) {
        if (!tenantModelNames.has(target)) continue;
        // The other side of a named self- or 1:1 relation defines no keys.
        if (!args.includes("fields:")) continue;
        expect(args, line.trim()).toMatch(/references: \[schoolId, id\]/);
        expect(args, line.trim()).toMatch(/fields: \[schoolId, \w+\]/);
      }
    },
  );
});
