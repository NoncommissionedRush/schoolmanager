// The report CSV format (docs/architecture/phase6-rules.md §5): UTF-8 with
// BOM, comma separator, CRLF, RFC 4180 quoting, a translated header row in
// a fixed column order, machine-readable values and a guard against
// spreadsheet formula injection. Pure: no Next.js, no database.

import {
  type AttendanceRow,
  formatRate,
  type ReportKind,
  type TeacherHoursRow,
  type TeacherLessonRow,
} from "./rules";

type Cell = string | number;

export type CsvColumn<Row> = {
  key: string;
  /** Text cells are user input and get the formula guard; numbers don't. */
  kind: "text" | "number";
  value: (row: Row) => Cell;
};

const text = <Row>(
  key: string,
  value: (row: Row) => string,
): CsvColumn<Row> => ({
  key,
  kind: "text",
  value,
});
const number = <Row>(
  key: string,
  value: (row: Row) => Cell,
): CsvColumn<Row> => ({ key, kind: "number", value });

/** §5, in order. The header of column `c` is `reports.csv.<report>.<c>`. */
export const CSV_COLUMNS: {
  [K in ReportKind]: readonly CsvColumn<CsvRows[K]>[];
} = {
  attendance: [
    text("student", (r) => r.studentName),
    text("group", (r) => r.groupName),
    text("level", (r) => r.levelCode),
    number("expected", (r) => r.expected),
    number("absent", (r) => r.absent),
    number("absentWithCredit", (r) => r.absentWithCredit),
    number("absentLate", (r) => r.absentLate),
    number("attended", (r) => r.attended),
    number("attendanceRate", (r) => formatRate(r.attendanceRate)),
    number("makeupsAttended", (r) => r.makeupsAttended),
  ],
  "teacher-hours": [
    text("teacher", (r) => r.name),
    number("lessons", (r) => r.lessons),
    number("regularMinutes", (r) => r.regularMinutes),
    number("substituteMinutes", (r) => r.substituteMinutes),
    number("totalMinutes", (r) => r.totalMinutes),
    number("hours", (r) => r.hours),
    number("coveredByOthersMinutes", (r) => r.coveredByOthersMinutes),
  ],
  "teacher-hours-lessons": [
    number("date", (r) => r.date),
    number("start", (r) => r.start),
    number("end", (r) => r.end),
    number("minutes", (r) => r.minutes),
    text("teacher", (r) => r.teacherName),
    number("role", (r) => r.role),
    text("regularTeacher", (r) => r.regularTeacherName),
    text("group", (r) => r.groupName),
    text("level", (r) => r.levelCode),
    text("room", (r) => r.roomName ?? ""),
    number("lessonId", (r) => r.lessonId),
  ],
};

export type CsvRows = {
  attendance: AttendanceRow;
  "teacher-hours": TeacherHoursRow;
  "teacher-hours-lessons": TeacherLessonRow;
};

const BOM = "\uFEFF";
const CRLF = "\r\n";

/** Prefixes text that a spreadsheet would run as a formula (§5). */
export function guardFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** RFC 4180: quote fields with `,`, `"`, CR or LF; double the quotes. */
export function quoteField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * The file: BOM, the header row (`header(key)` gives the translated name),
 * then one CRLF-terminated record per row. No totals row; no rows gives a
 * header-only file.
 */
export function toCsv<Row>(
  columns: readonly CsvColumn<Row>[],
  rows: readonly Row[],
  header: (key: string) => string,
): string {
  const record = (cells: string[]) => cells.map(quoteField).join(",") + CRLF;
  let out = BOM + record(columns.map((c) => header(c.key)));
  for (const row of rows) {
    out += record(
      columns.map((c) => {
        const value = String(c.value(row));
        return c.kind === "text" ? guardFormula(value) : value;
      }),
    );
  }
  return out;
}

/** `<report>_<from>_<to>.csv` (§5). */
export const csvFileName = (report: ReportKind, from: string, to: string) =>
  `${report}_${from}_${to}.csv`;

/** `toCsv` with the report's columns. */
export function reportCsv<K extends ReportKind>(
  report: K,
  rows: readonly CsvRows[K][],
  header: (key: string) => string,
): string {
  return toCsv(CSV_COLUMNS[report], rows, header);
}
