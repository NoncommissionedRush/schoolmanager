import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Static guards for phase5-rules.md §4.4: ratings are admin-readable only.
//
// 1. The admin read functions (`admin.ts`, `admin-data.ts`) may only be
//    imported from src/app/admin/** and src/server/ratings/**.
// 2. Only src/server/ratings/** touches the `TeacherRating` model: a direct
//    `db.teacherRating…` call, a relation read (`teacherRatings`,
//    `hiddenRatings`, a teacher's or term's `ratings`) or raw SQL on
//    `teacher_ratings` anywhere else fails here.
// 3. Nothing under src/app/teacher/** imports the ratings module at all.

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

const RATINGS_DIR = path.join("src", "server", "ratings");
const ADMIN_APP_DIR = path.join("src", "app", "admin");
const TEACHER_APP_DIR = path.join("src", "app", "teacher");

const ADMIN_IMPORT =
  /from\s+["'](@\/server\/ratings\/admin(-data)?|\.{1,2}\/(.*\/)?admin(-data)?)["']|import\(\s*["']@\/server\/ratings\/admin/;
const ANY_RATINGS_IMPORT = /["']@\/server\/ratings(\/[\w-]+)?["']/;
const MODEL_ACCESS =
  /\bteacherRatings?\b|\bhiddenRatings\b|\bteacher_ratings\b|\bratings\s*:\s*(true|\{\s*(select|where|include|orderBy|take)\b)/;

const lines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((line, i) => ({ file, line, at: `${file}:${i + 1}` }));

const importsAdmin = (file: string, line: string) => {
  if (!ADMIN_IMPORT.test(line)) return false;
  // A relative `./admin` only means the ratings module inside its own folder.
  if (/from\s+["']\.{1,2}\//.test(line)) {
    return path.dirname(file) === RATINGS_DIR;
  }
  return true;
};

describe("ratings read paths", () => {
  const files = sourceFiles("src");

  it("only admin pages and the ratings module import the admin reads", () => {
    const offenders = files
      .filter(
        (file) =>
          !file.startsWith(RATINGS_DIR + path.sep) &&
          !file.startsWith(ADMIN_APP_DIR + path.sep),
      )
      .flatMap(lines)
      .filter(({ file, line }) => importsAdmin(file, line))
      .map(({ at, line }) => `${at}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  it("only src/server/ratings touches the TeacherRating model", () => {
    const offenders = files
      .filter((file) => !file.startsWith(RATINGS_DIR + path.sep))
      .flatMap(lines)
      .filter(({ line }) => MODEL_ACCESS.test(line))
      .map(({ at, line }) => `${at}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  it("teacher pages never import the ratings module", () => {
    const offenders = files
      .filter((file) => file.startsWith(TEACHER_APP_DIR + path.sep))
      .flatMap(lines)
      .filter(({ line }) => ANY_RATINGS_IMPORT.test(line))
      .map(({ at, line }) => `${at}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  it("student.ts never imports the admin reads", () => {
    const offenders = lines(path.join(RATINGS_DIR, "student.ts")).filter(
      ({ line }) => /admin(-data)?["']/.test(line) && /\bfrom\b/.test(line),
    );
    expect(offenders).toEqual([]);
  });

  it("catches the patterns it guards against", () => {
    for (const line of [
      'import { adminRatingsOverview } from "@/server/ratings/admin";',
      'import { loadRatingsOverview } from "@/server/ratings/admin-data";',
    ]) {
      expect(importsAdmin("src/app/teacher/page.tsx", line), line).toBe(true);
    }
    for (const line of [
      "await db.teacherRating.findMany();",
      "include: { teacherRatings: true },",
      "select: { ratings: { select: { score: true } } },",
      "await db.$queryRaw`SELECT * FROM teacher_ratings`;",
    ]) {
      expect(MODEL_ACCESS.test(line), line).toBe(true);
    }
    expect(MODEL_ACCESS.test('const t = useTranslations("ratings");')).toBe(
      false,
    );
  });
});
