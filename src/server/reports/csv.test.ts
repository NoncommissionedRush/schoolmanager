import { describe, expect, it } from "vitest";

import en from "../../../messages/en-GB/reports.json";

import {
  CSV_COLUMNS,
  csvFileName,
  guardFormula,
  quoteField,
  reportCsv,
  toCsv,
} from "./csv";
import { type AttendanceRow, REPORTS, type TeacherLessonRow } from "./rules";

/** A strict RFC 4180 reader, written independently of the writer. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i++;
    } else field += c;
  }
  expect(field, "no unterminated last record").toBe("");
  return records;
}

const header = (report: keyof typeof en.csv) => (key: string) =>
  (en.csv[report] as Record<string, string>)[key];

const attendanceRow = (extra: Partial<AttendanceRow> = {}): AttendanceRow => ({
  studentId: "s1",
  studentName: "Sara",
  studentArchived: false,
  groupId: "g1",
  groupName: "B1 Evening",
  groupType: "GROUP",
  levelCode: "B1",
  groupArchived: false,
  expected: 8,
  absent: 1,
  absentWithCredit: 1,
  absentLate: 0,
  attended: 7,
  attendanceRate: 875,
  makeupsAttended: 1,
  ...extra,
});

describe("CSV format (§5)", () => {
  it("starts with a BOM, ends records with CRLF and quotes per RFC 4180", () => {
    const csv = toCsv(
      [{ key: "a", kind: "text", value: (r: { a: string }) => r.a }],
      [
        { a: "plain" },
        { a: "with, comma" },
        { a: 'say "hi"' },
        { a: "two\nlines" },
      ],
      (key) => key.toUpperCase(),
    );
    expect(csv.startsWith("﻿A\r\n")).toBe(true);
    expect(csv).toBe(
      '﻿A\r\nplain\r\n"with, comma"\r\n"say ""hi"""\r\n"two\nlines"\r\n',
    );
    expect(quoteField("cr\r")).toBe('"cr\r"');
  });

  it("guards text cells that a spreadsheet would run as a formula", () => {
    for (const value of ["=SUM(A1)", "+1", "-1", "@cmd", "\tx", "\rx"]) {
      expect(guardFormula(value)).toBe(`'${value}`);
    }
    expect(guardFormula("Sara")).toBe("Sara");
    expect(guardFormula("a=b")).toBe("a=b");
  });

  it("never prefixes numeric columns, only text ones", () => {
    const csv = reportCsv(
      "attendance",
      [attendanceRow({ studentName: "=HYPERLINK(1)", groupName: "-x" })],
      header("attendance"),
    );
    const [, record] = parseCsv(csv.slice(1));
    expect(record).toEqual([
      "'=HYPERLINK(1)",
      "'-x",
      "B1",
      "8",
      "1",
      "1",
      "0",
      "7",
      "87.5",
      "1",
    ]);
  });

  it("writes machine-readable values: codes, dots, empty rates, ISO dates", () => {
    const row: TeacherLessonRow = {
      lessonId: "0b9c7c6e-4f1c-4d7e-9f53-0a7d3c0f2b11",
      startsAt: new Date("2026-10-05T15:00:00Z"),
      date: "2026-10-05",
      start: "17:00",
      end: "18:30",
      minutes: 90,
      teacherId: "t2",
      teacherName: "Ana",
      role: "SUBSTITUTE",
      regularTeacherId: "t1",
      regularTeacherName: "Tomas",
      groupId: "g1",
      groupName: "B1 Evening",
      groupType: "GROUP",
      levelCode: "B1",
      roomName: null,
    };
    const [, lessons] = parseCsv(
      reportCsv(
        "teacher-hours-lessons",
        [row],
        header("teacher-hours-lessons"),
      ).slice(1),
    );
    expect(lessons).toEqual([
      "2026-10-05",
      "17:00",
      "18:30",
      "90",
      "Ana",
      "SUBSTITUTE",
      "Tomas",
      "B1 Evening",
      "B1",
      "",
      row.lessonId,
    ]);
    const [, attendance] = parseCsv(
      reportCsv(
        "attendance",
        [
          attendanceRow({
            expected: 0,
            attended: 0,
            absent: 0,
            attendanceRate: null,
          }),
        ],
        header("attendance"),
      ).slice(1),
    );
    expect(attendance[8]).toBe("");
    const [, hours] = parseCsv(
      reportCsv(
        "teacher-hours",
        [
          {
            teacherId: "t1",
            name: "Tomas",
            archived: false,
            lessons: 3,
            regularMinutes: 600,
            substituteMinutes: 150,
            totalMinutes: 750,
            hours: "12.50",
            coveredByOthersMinutes: 45,
          },
        ],
        header("teacher-hours"),
      ).slice(1),
    );
    expect(hours).toEqual(["Tomas", "3", "600", "150", "750", "12.50", "45"]);
  });

  it("an empty result is a header-only file", () => {
    for (const report of REPORTS) {
      const csv = reportCsv(report, [], header(report));
      expect(parseCsv(csv.slice(1))).toHaveLength(1);
    }
  });

  it("round-trips through a CSV parser", () => {
    const rows = [
      attendanceRow({ studentName: 'O"Brien, Jr.' }),
      attendanceRow({ studentName: "Line\r\nbreak", groupName: "Ü A1 ✓" }),
    ];
    const parsed = parseCsv(
      reportCsv("attendance", rows, header("attendance")).slice(1),
    );
    expect(parsed.map((r) => r[0])).toEqual([
      "Student",
      'O"Brien, Jr.',
      "Line\r\nbreak",
    ]);
    expect(parsed[2][1]).toBe("Ü A1 ✓");
  });

  it("keeps a fixed column order, with a header key for every column", () => {
    expect(
      Object.fromEntries(
        REPORTS.map((r) => [r, CSV_COLUMNS[r].map((c) => c.key)]),
      ),
    ).toMatchInlineSnapshot(`
      {
        "attendance": [
          "student",
          "group",
          "level",
          "expected",
          "absent",
          "absentWithCredit",
          "absentLate",
          "attended",
          "attendanceRate",
          "makeupsAttended",
        ],
        "teacher-hours": [
          "teacher",
          "lessons",
          "regularMinutes",
          "substituteMinutes",
          "totalMinutes",
          "hours",
          "coveredByOthersMinutes",
        ],
        "teacher-hours-lessons": [
          "date",
          "start",
          "end",
          "minutes",
          "teacher",
          "role",
          "regularTeacher",
          "group",
          "level",
          "room",
          "lessonId",
        ],
      }
    `);
    for (const report of REPORTS) {
      expect(Object.keys(en.csv[report])).toEqual(
        CSV_COLUMNS[report].map((c) => c.key),
      );
    }
  });

  it("names the file <report>_<from>_<to>.csv", () => {
    expect(csvFileName("teacher-hours", "2026-09-01", "2026-12-20")).toBe(
      "teacher-hours_2026-09-01_2026-12-20.csv",
    );
  });
});
