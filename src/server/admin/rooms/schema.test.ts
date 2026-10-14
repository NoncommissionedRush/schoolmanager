import { describe, expect, it } from "vitest";

import { parseInput } from "../validation";
import { roomSchema } from "./schema";

describe("room schema (§6.9)", () => {
  it("requires a capacity for physical rooms", () => {
    const result = parseInput(roomSchema, { name: "Room 1", kind: "PHYSICAL" });
    expect(result).toEqual({
      ok: false,
      fieldErrors: {
        capacity: {
          key: "validation.integerRange",
          values: { min: 1, max: 500 },
        },
      },
    });
  });

  it("drops the meeting link of physical rooms", () => {
    expect(
      parseInput(roomSchema, {
        name: "Room 1",
        kind: "PHYSICAL",
        capacity: "12",
        meetingUrl: "https://meet.example.com",
      }),
    ).toEqual({
      ok: true,
      data: {
        name: "Room 1",
        kind: "PHYSICAL",
        capacity: 12,
        meetingUrl: null,
      },
    });
  });

  it("lets online rooms have no capacity and an https link", () => {
    expect(
      parseInput(roomSchema, {
        name: "Zoom",
        kind: "ONLINE",
        capacity: "",
        meetingUrl: "https://zoom.example.com/j/1",
      }),
    ).toEqual({
      ok: true,
      data: {
        name: "Zoom",
        kind: "ONLINE",
        capacity: null,
        meetingUrl: "https://zoom.example.com/j/1",
      },
    });
  });
});
