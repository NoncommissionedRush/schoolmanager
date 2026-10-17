import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Static guard for phase6-rules.md §6: the report loaders (`admin.ts`,
// `admin-data.ts`) may only be imported from src/app/admin/**,
// src/app/api/admin/reports/** and src/server/reports/**. Type-only imports
// (`import type …`) are erased at build time and can't load anything, so
// shared report components may use the result types.

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "generated" ? [] : sourceFiles(file);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [file]
      : [];
  });
}

const ALLOWED = [
  path.join("src", "app", "admin"),
  path.join("src", "app", "api", "admin", "reports"),
  path.join("src", "server", "reports"),
].map((dir) => dir + path.sep);
const REPORTS_DIR = path.join("src", "server", "reports");

/** Every module specifier a file imports or re-exports, with type-only-ness. */
function importsOf(source: string) {
  const out: { specifier: string; typeOnly: boolean }[] = [];
  const statement =
    /\b(import|export)\s+(type\s+)?(?:[\w*{}\s,$]*?\bfrom\s+)?["']([^"']+)["']/g;
  for (const m of source.matchAll(statement)) {
    out.push({ specifier: m[3], typeOnly: !!m[2] });
  }
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    out.push({ specifier: m[1], typeOnly: false });
  }
  return out;
}

const loaderModule = (file: string, specifier: string) => {
  if (/^@\/server\/reports\/admin(-data)?$/.test(specifier)) return true;
  if (!specifier.startsWith(".")) return false;
  const resolved = path.join(path.dirname(file), specifier);
  return (
    resolved === path.join(REPORTS_DIR, "admin") ||
    resolved === path.join(REPORTS_DIR, "admin-data")
  );
};

describe("report read paths (§6)", () => {
  it("parses import statements, including multi-line and type-only ones", () => {
    expect(
      importsOf(
        `import { a,\n  b } from "@/server/reports/admin";\nimport type { C } from "./admin-data";\nexport { d } from "x";\nconst e = await import("y");\nimport "server-only";`,
      ),
    ).toEqual([
      { specifier: "@/server/reports/admin", typeOnly: false },
      { specifier: "./admin-data", typeOnly: true },
      { specifier: "x", typeOnly: false },
      { specifier: "server-only", typeOnly: false },
      { specifier: "y", typeOnly: false },
    ]);
  });

  it("only admin pages, the CSV route and the reports module import the loaders", () => {
    const offenders = sourceFiles("src")
      .filter((file) => !ALLOWED.some((dir) => file.startsWith(dir)))
      .flatMap((file) =>
        importsOf(readFileSync(file, "utf8"))
          .filter((i) => !i.typeOnly && loaderModule(file, i.specifier))
          .map((i) => `${file}: ${i.specifier}`),
      );
    expect(offenders).toEqual([]);
  });

  it("the guard would catch an import from elsewhere", () => {
    const file = path.join("src", "app", "teacher", "page.tsx");
    expect(loaderModule(file, "@/server/reports/admin")).toBe(true);
    expect(loaderModule(file, "@/server/reports/admin-data")).toBe(true);
    expect(loaderModule(file, "@/server/reports/rules")).toBe(false);
    expect(loaderModule(path.join(REPORTS_DIR, "x.ts"), "./admin-data")).toBe(
      true,
    );
  });
});
