import { describe, expect, it } from "vitest";

import {
  applyDraftSchema,
  lockAssignmentsSchema,
  saveAssignmentSchema,
  startRunSchema,
} from "./generator-schema";

const id = "6f1d3c1e-2b8a-4f5e-9c47-0a9e1d2b7c55";

describe("generator action input", () => {
  it("accepts well-formed requests", () => {
    expect(
      startRunSchema.safeParse({ termId: id, mode: "REPLACE" }).success,
    ).toBe(true);
    expect(
      startRunSchema.safeParse({
        termId: id,
        mode: "REPLAN_FROM",
        effectiveFrom: "2026-10-26",
      }).success,
    ).toBe(true);
    expect(
      saveAssignmentSchema.safeParse({
        draftId: id,
        version: 3,
        groupId: id,
        teacherId: null,
      }).success,
    ).toBe(true);
    expect(
      applyDraftSchema.safeParse({
        draftId: id,
        version: 0,
        acknowledgedConflictKeys: ["maxHours:x"],
        publish: true,
      }).success,
    ).toBe(true);
  });

  it("rejects malformed ids, modes, dates and extra fields", () => {
    expect(
      startRunSchema.safeParse({ termId: "nope", mode: "REPLACE" }).success,
    ).toBe(false);
    expect(
      startRunSchema.safeParse({ termId: id, mode: "SHUFFLE" }).success,
    ).toBe(false);
    expect(
      startRunSchema.safeParse({
        termId: id,
        mode: "FILL",
        effectiveFrom: "26.10.2026",
      }).success,
    ).toBe(false);
    // The budget is not the client's to choose.
    expect(
      startRunSchema.safeParse({
        termId: id,
        mode: "FILL",
        maxIterations: 1e9,
      }).success,
    ).toBe(false);
    expect(
      saveAssignmentSchema.safeParse({
        draftId: id,
        version: -1,
        groupId: id,
        teacherId: id,
      }).success,
    ).toBe(false);
    expect(
      lockAssignmentsSchema.safeParse({
        draftId: id,
        version: 1,
        groupIds: [],
        locked: true,
      }).success,
    ).toBe(false);
  });
});
