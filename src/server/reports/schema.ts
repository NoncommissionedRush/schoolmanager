// The report query (docs/architecture/phase6-rules.md §2): the same URL
// parameters for the pages and the CSV route, parsed with one zod schema.

import { z } from "zod";

import { isUuid } from "@/server/lessons/access";

import {
  ATTENDANCE_SORTS,
  type AttendanceSort,
  ReportError,
  type SortDirection,
} from "./rules";

/** What `loadReport` reads: the period and the filters. */
export type ReportInput = {
  termId?: string;
  from?: string;
  to?: string;
  teacherId?: string;
  groupId?: string;
  studentId?: string;
};

/** Page-only parameters on top of the input. */
export type ReportQuery = {
  input: ReportInput;
  sort: AttendanceSort;
  direction: SortDirection;
  page: number;
};

const blank = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const id = z.preprocess(blank, z.string().refine(isUuid).optional());
// Checked by `resolvePeriod`, so a malformed date is an `INVALID_RANGE`.
const date = z.preprocess(blank, z.string().max(32).optional());

export const reportQuerySchema = z.object({
  term: id,
  from: date,
  to: date,
  teacher: id,
  group: id,
  student: id,
  sort: z.enum(ATTENDANCE_SORTS).catch("group"),
  dir: z.enum(["asc", "desc"]).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

const first = (params: Params, name: string) => {
  if (params instanceof URLSearchParams) return params.get(name) ?? undefined;
  const value = params[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Parses the URL parameters. A malformed id is `NOT_FOUND`, like an id of
 * another school.
 */
export function parseReportQuery(params: Params): ReportQuery {
  const raw = Object.fromEntries(
    Object.keys(reportQuerySchema.shape).map((key) => [
      key,
      first(params, key),
    ]),
  );
  const parsed = reportQuerySchema.safeParse(raw);
  if (!parsed.success) throw new ReportError("NOT_FOUND");
  const q = parsed.data;
  const input: ReportInput = {};
  if (q.term) input.termId = q.term;
  if (q.from) input.from = q.from;
  if (q.to) input.to = q.to;
  if (q.teacher) input.teacherId = q.teacher;
  if (q.group) input.groupId = q.group;
  if (q.student) input.studentId = q.student;
  return {
    input,
    sort: q.sort,
    // Names read A→Z by default; counts and rates lowest first, so the
    // students who miss most come first (design spec §4.1).
    direction: q.dir ?? "asc",
    page: q.page,
  };
}

/** The query string of an input (for links and the CSV URL). */
export function reportSearch(
  input: ReportInput,
  extra: Record<string, string | number | undefined> = {},
): string {
  const search = new URLSearchParams();
  const set = (key: string, value: string | number | undefined) => {
    if (value !== undefined && value !== "") search.set(key, String(value));
  };
  set("term", input.termId);
  set("from", input.from);
  set("to", input.to);
  set("teacher", input.teacherId);
  set("group", input.groupId);
  set("student", input.studentId);
  for (const [key, value] of Object.entries(extra)) set(key, value);
  const query = search.toString();
  return query ? `?${query}` : "";
}
