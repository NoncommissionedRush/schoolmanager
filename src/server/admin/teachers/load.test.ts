import { describe, expect, it } from "vitest";

import {
  colorName,
  createTeacherSchema,
  nextUnusedColor,
  TEACHER_COLORS,
  updateTeacherSchema,
} from "../people/schema";
import { parseInput } from "../validation";
import { type LoadSlot, pickCurrentTerm, teacherLoad } from "./load";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const term = (id: string, start: string, end: string) => ({
  id,
  startDate: d(start),
  endDate: d(end),
});

describe("pickCurrentTerm", () => {
  const spring = term("spring", "2026-02-01", "2026-06-30");
  const autumn = term("autumn", "2026-09-14", "2027-01-29");
  const next = term("next", "2027-02-01", "2027-06-30");

  it("picks the term running today", () => {
    expect(pickCurrentTerm([next, autumn, spring], d("2026-10-14"))).toBe(
      autumn,
    );
  });

  it("includes the first and last day", () => {
    expect(pickCurrentTerm([autumn], d("2026-09-14"))).toBe(autumn);
    expect(pickCurrentTerm([autumn], d("2027-01-29"))).toBe(autumn);
  });

  it("falls back to the next term to start", () => {
    expect(pickCurrentTerm([next, autumn, spring], d("2026-07-15"))).toBe(
      autumn,
    );
  });

  it("falls back to the last finished term", () => {
    expect(pickCurrentTerm([spring, autumn], d("2027-03-01"))).toBe(autumn);
  });

  it("is null without terms", () => {
    expect(pickCurrentTerm([], d("2026-10-14"))).toBeNull();
  });
});

describe("teacherLoad", () => {
  const autumn = term("autumn", "2026-09-14", "2027-01-29");
  const slot = (overrides: Partial<LoadSlot>): LoadSlot => ({
    teacherId: "t1",
    groupId: "g1",
    termId: "autumn",
    validFrom: null,
    validUntil: null,
    ...overrides,
  });

  it("counts distinct groups and weekly slots per teacher", () => {
    const load = teacherLoad(
      [
        slot({}),
        slot({}),
        slot({ groupId: "g2" }),
        slot({ teacherId: "t2", groupId: "g3" }),
      ],
      autumn,
      d("2026-10-14"),
    );
    expect(load.get("t1")).toEqual({ groups: 2, lessonsPerWeek: 3 });
    expect(load.get("t2")).toEqual({ groups: 1, lessonsPerWeek: 1 });
  });

  it("does not count a slot twice when it moves mid-term", () => {
    const load = teacherLoad(
      [
        slot({ validUntil: d("2026-10-25") }),
        slot({ validFrom: d("2026-10-26") }),
      ],
      autumn,
      d("2026-10-14"),
    );
    expect(load.get("t1")).toEqual({ groups: 1, lessonsPerWeek: 1 });
  });

  it("uses the first day of a term that hasn't started", () => {
    const upcoming = term("next", "2027-02-01", "2027-06-30");
    const load = teacherLoad(
      [
        slot({ termId: "next" }),
        slot({ termId: "next", validFrom: d("2027-03-01") }),
      ],
      upcoming,
      d("2027-01-30"),
    );
    expect(load.get("t1")?.lessonsPerWeek).toBe(1);
  });

  it("counts groups from other running terms but not their lessons", () => {
    const load = teacherLoad(
      [slot({ termId: "next", groupId: "g9" })],
      autumn,
      d("2026-10-14"),
    );
    expect(load.get("t1")).toEqual({ groups: 1, lessonsPerWeek: 0 });
  });
});

describe("teacher colours", () => {
  it("defaults to the first unused swatch", () => {
    expect(nextUnusedColor([])).toBe("blue");
    expect(nextUnusedColor([TEACHER_COLORS.blue, "#123456", null])).toBe(
      "teal",
    );
    expect(nextUnusedColor([TEACHER_COLORS.blue.toUpperCase()])).toBe("teal");
  });

  it("cycles once every swatch is used", () => {
    const all = Object.values(TEACHER_COLORS);
    expect(nextUnusedColor(all)).toBe("blue");
  });

  it("maps stored hex values back to swatch names", () => {
    expect(colorName("#0D9488")).toBe("teal");
    expect(colorName("#d97706")).toBeNull();
    expect(colorName(null)).toBeNull();
  });

  it("accepts an empty colour (server picks the default)", () => {
    const result = parseInput(createTeacherSchema, {
      name: "Ada Lovelace",
      email: "Ada@Example.com",
      password: "long-enough-1",
      color: "",
    });
    expect(result.ok && result.data).toMatchObject({
      email: "ada@example.com",
      color: null,
    });
  });

  it("rejects an unknown colour and a long bio", () => {
    const result = parseInput(updateTeacherSchema, {
      name: "Ada Lovelace",
      email: "ada@example.com",
      color: "magenta",
      bio: "x".repeat(1001),
    });
    expect(!result.ok && Object.keys(result.fieldErrors).sort()).toEqual([
      "bio",
      "color",
    ]);
  });
});
