import { describe, expect, it } from "vitest";

import {
  endSlotSchema,
  saveSlotSchema,
  slotRequestSchema,
} from "./slot-schema";

const id = "6f1d3c1e-2b8a-4f5e-9c47-0a9e1d2b7c55";
const request = {
  slot: {
    termId: id,
    groupId: id,
    teacherId: id,
    roomId: null,
    weekday: 1,
    startMinute: 600,
    endMinute: 660,
  },
};

describe("slot action input", () => {
  it("accepts a well-formed request", () => {
    expect(slotRequestSchema.safeParse(request).success).toBe(true);
    expect(
      slotRequestSchema.safeParse({
        ...request,
        slotId: id,
        effectiveFrom: "2026-10-20",
      }).success,
    ).toBe(true);
  });

  it("rejects malformed ids, days, times and dates", () => {
    const bad = [
      { ...request, slot: { ...request.slot, groupId: "nope" } },
      { ...request, slot: { ...request.slot, weekday: 0 } },
      { ...request, slot: { ...request.slot, endMinute: 1441 } },
      { ...request, slot: { ...request.slot, startMinute: 1.5 } },
      { ...request, effectiveFrom: "20 Oct" },
    ];
    for (const input of bad) {
      expect(slotRequestSchema.safeParse(input).success).toBe(false);
    }
  });

  it("rejects unknown fields (no schoolId smuggling)", () => {
    expect(
      slotRequestSchema.safeParse({ ...request, schoolId: id }).success,
    ).toBe(false);
    expect(
      slotRequestSchema.safeParse({
        ...request,
        slot: { ...request.slot, schoolId: id },
      }).success,
    ).toBe(false);
  });

  it("needs the acknowledged keys to save, the reason is optional", () => {
    expect(saveSlotSchema.safeParse(request).success).toBe(false);
    expect(
      saveSlotSchema.safeParse({ ...request, acknowledgedConflictKeys: [] })
        .success,
    ).toBe(true);
    const parsed = saveSlotSchema.parse({
      ...request,
      acknowledgedConflictKeys: ["OUTSIDE_SCHOOL_HOURS"],
      reason: "  agreed  ",
    });
    expect(parsed.reason).toBe("agreed");
  });

  it("validates the end request", () => {
    expect(
      endSlotSchema.safeParse({ slotId: id, lastDate: "2026-11-14" }).success,
    ).toBe(true);
    expect(endSlotSchema.safeParse({ slotId: id }).success).toBe(false);
  });
});
