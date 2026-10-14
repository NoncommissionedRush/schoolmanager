import { describe, expect, it } from "vitest";

import { parseInput } from "../validation";
import { lessonChangeParts } from "./lesson-result";
import {
  datesChanged,
  isCurrentTerm,
  overlappingTerms,
  termSchema,
} from "./schema";

const term = {
  name: "Spring 2027",
  startDate: "2027-02-01",
  endDate: "2027-06-30",
};

describe("term schema (§6.8)", () => {
  it("accepts a valid term, including a single-day one", () => {
    expect(parseInput(termSchema(), term)).toEqual({ ok: true, data: term });
    expect(
      parseInput(termSchema(), { ...term, endDate: term.startDate }).ok,
    ).toBe(true);
  });

  it("rejects an end before the start", () => {
    expect(
      parseInput(termSchema(), { ...term, endDate: "2027-01-31" }),
    ).toEqual({
      ok: false,
      fieldErrors: { endDate: { key: "terms.error.endBeforeStart" } },
    });
  });

  it("requires name and valid dates", () => {
    const result = parseInput(termSchema(), {
      name: " ",
      startDate: "2027-02-30",
      endDate: "",
    });
    expect(result).toEqual({
      ok: false,
      fieldErrors: {
        name: { key: "validation.requiredField" },
        startDate: { key: "validation.date" },
        endDate: { key: "validation.requiredField" },
      },
    });
  });

  describe("published term", () => {
    const context = {
      published: true,
      original: { startDate: "2026-09-14", endDate: "2027-01-29" },
      today: "2026-10-14",
    };
    const published = { name: "Autumn", ...context.original };

    it("allows moving the end to a later future date", () => {
      expect(
        parseInput(termSchema(context), {
          ...published,
          endDate: "2027-02-05",
        }).ok,
      ).toBe(true);
    });

    it("refuses moving the end before today", () => {
      expect(
        parseInput(termSchema(context), {
          ...published,
          endDate: "2026-10-13",
        }),
      ).toEqual({
        ok: false,
        fieldErrors: { endDate: { key: "terms.error.cannotRemovePast" } },
      });
    });

    it("refuses changing a start that already passed", () => {
      expect(
        parseInput(termSchema(context), {
          ...published,
          startDate: "2026-10-20",
        }),
      ).toEqual({
        ok: false,
        fieldErrors: { startDate: { key: "terms.error.cannotRemovePast" } },
      });
    });

    it("keeps unchanged past dates valid", () => {
      expect(parseInput(termSchema(context), published).ok).toBe(true);
    });

    it("does not apply to draft terms", () => {
      expect(
        parseInput(termSchema({ ...context, published: false }), {
          ...published,
          startDate: "2026-01-01",
        }).ok,
      ).toBe(true);
    });
  });

  it("detects date changes", () => {
    expect(datesChanged(term, term)).toBe(false);
    expect(datesChanged({ ...term, endDate: "2027-07-01" }, term)).toBe(true);
  });
});

describe("term overlap", () => {
  const terms = [
    { id: "a", name: "Autumn", startDate: "2026-09-14", endDate: "2027-01-29" },
    { id: "s", name: "Summer", startDate: "2027-07-01", endDate: "2027-08-31" },
  ];

  it("finds terms sharing at least one day (inclusive)", () => {
    expect(
      overlappingTerms(
        { startDate: "2027-01-29", endDate: "2027-06-30" },
        terms,
      ).map((t) => t.name),
    ).toEqual(["Autumn"]);
    expect(
      overlappingTerms(
        { startDate: "2027-02-01", endDate: "2027-06-30" },
        terms,
      ),
    ).toEqual([]);
  });

  it("ignores the term being edited", () => {
    expect(
      overlappingTerms(
        { startDate: "2026-10-01", endDate: "2026-12-01" },
        terms,
        "a",
      ),
    ).toEqual([]);
  });

  it("marks the current term", () => {
    expect(isCurrentTerm(terms[0], "2026-10-14")).toBe(true);
    expect(isCurrentTerm(terms[0], "2027-01-29")).toBe(true);
    expect(isCurrentTerm(terms[1], "2026-10-14")).toBe(false);
  });
});

describe("lesson change toast parts", () => {
  it("lists only non-zero parts in order", () => {
    expect(lessonChangeParts({ created: 9, removed: 0, cancelled: 1 })).toEqual(
      [
        { key: "terms.result.created", values: { count: 9 } },
        { key: "terms.result.cancelled", values: { count: 1 } },
      ],
    );
  });

  it("says nothing changed when all are zero", () => {
    expect(lessonChangeParts({ created: 0, removed: 0, cancelled: 0 })).toEqual(
      [{ key: "terms.result.none" }],
    );
  });
});
