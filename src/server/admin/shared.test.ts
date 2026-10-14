import { describe, expect, it } from "vitest";

import { AdminError } from "./result";
import { assertIds, assertOptionalId } from "./shared";

const ID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
// Seeded rows use v5 UUIDs (prisma/seed/ids.ts).
const SEEDED_ID = "2b0f3c4d-5e6f-5a7b-8c9d-0e1f2a3b4c5d";

function refusal(run: () => void): AdminError {
  try {
    run();
  } catch (error) {
    if (error instanceof AdminError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("assertIds", () => {
  it("accepts UUIDs", () => {
    expect(() => assertIds(ID, SEEDED_ID, ID.toUpperCase())).not.toThrow();
  });

  it.each([
    ["nonsense"],
    [""],
    [`${ID} `],
    [ID.slice(1)],
    [null],
    [undefined],
    [42],
    [{ id: ID }],
  ])("refuses %j as not found", (value) => {
    expect(refusal(() => assertIds(ID, value)).error).toEqual({
      key: "common.error.notFound",
    });
  });
});

describe("assertOptionalId", () => {
  it("accepts null and UUIDs", () => {
    expect(() => assertOptionalId(null)).not.toThrow();
    expect(() => assertOptionalId(ID)).not.toThrow();
  });

  it("refuses anything else as not found", () => {
    for (const value of ["nonsense", "", undefined]) {
      expect(refusal(() => assertOptionalId(value)).error).toEqual({
        key: "common.error.notFound",
      });
    }
  });
});
