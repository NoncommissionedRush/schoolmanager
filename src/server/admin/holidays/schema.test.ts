import { describe, expect, it } from "vitest";

import { parseInput } from "../validation";
import { holidaySchema, isOutsideTerm, touchedPublishedTerms } from "./schema";

const TERM_ID = "0b9f5a3e-8f0e-4c55-9b2b-0c6f1a2b3c4d";

describe("holiday schema (§6.8)", () => {
  it("saves a school-wide holiday with termId null", () => {
    expect(
      parseInput(holidaySchema, {
        name: "May Day",
        startDate: "2027-05-01",
        endDate: "2027-05-01",
        scope: "school",
        termId: TERM_ID,
      }),
    ).toEqual({
      ok: true,
      data: {
        name: "May Day",
        startDate: "2027-05-01",
        endDate: "2027-05-01",
        termId: null,
      },
    });
  });

  it("keeps the term of a term holiday", () => {
    const result = parseInput(holidaySchema, {
      name: "Spring break",
      startDate: "2027-04-01",
      endDate: "2027-04-05",
      scope: "term",
      termId: TERM_ID,
    });
    expect(result.ok && result.data.termId).toBe(TERM_ID);
  });

  it("requires a term when it applies to one term", () => {
    expect(
      parseInput(holidaySchema, {
        name: "Spring break",
        startDate: "2027-04-01",
        endDate: "2027-04-05",
        scope: "term",
        termId: "",
      }),
    ).toEqual({
      ok: false,
      fieldErrors: {
        termId: {
          key: "validation.select",
          values: { field: { key: "holidays.field.term" } },
        },
      },
    });
  });

  it("rejects an end before the start", () => {
    expect(
      parseInput(holidaySchema, {
        name: "Oops",
        startDate: "2027-04-05",
        endDate: "2027-04-01",
        scope: "school",
      }),
    ).toEqual({
      ok: false,
      fieldErrors: { endDate: { key: "terms.error.endBeforeStart" } },
    });
  });
});

describe("published terms a holiday touches", () => {
  const terms = [
    {
      id: "autumn",
      startDate: "2026-09-14",
      endDate: "2027-01-29",
      published: true,
    },
    {
      id: "spring",
      startDate: "2027-02-01",
      endDate: "2027-06-30",
      published: false,
    },
    {
      id: "summer",
      startDate: "2027-07-01",
      endDate: "2027-08-31",
      published: true,
    },
  ];

  it("school-wide: every published term it overlaps", () => {
    expect(
      touchedPublishedTerms(
        { termId: null, startDate: "2027-01-29", endDate: "2027-07-01" },
        terms,
      ),
    ).toEqual(["autumn", "summer"]);
    expect(
      touchedPublishedTerms(
        { termId: null, startDate: "2027-03-01", endDate: "2027-03-02" },
        terms,
      ),
    ).toEqual([]);
  });

  it("term holiday: only its own term, if published", () => {
    expect(
      touchedPublishedTerms(
        { termId: "autumn", startDate: "2027-03-01", endDate: "2027-03-02" },
        terms,
      ),
    ).toEqual(["autumn"]);
    expect(
      touchedPublishedTerms(
        { termId: "spring", startDate: "2026-10-01", endDate: "2026-10-02" },
        terms,
      ),
    ).toEqual([]);
  });

  it("flags term holidays outside their term", () => {
    const term = terms[1];
    expect(
      isOutsideTerm({ startDate: "2027-02-01", endDate: "2027-02-01" }, term),
    ).toBe(false);
    expect(
      isOutsideTerm({ startDate: "2027-06-30", endDate: "2027-07-02" }, term),
    ).toBe(true);
    expect(
      isOutsideTerm({ startDate: "2020-01-01", endDate: "2020-01-01" }, null),
    ).toBe(false);
  });
});
