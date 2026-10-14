import { describe, expect, it } from "vitest";

import { parseInput } from "../validation";
import {
  compactLessonTimes,
  firstOverlap,
  lessonTimesLabel,
  lessonTimesSchema,
  lessonTimeWarnings,
  type RoomInfo,
  roomClashes,
  weeklyMinutes,
} from "./lesson-times";

const ROOM = "11111111-1111-4111-8111-111111111111";
const ONLINE = "22222222-2222-4222-8222-222222222222";
const SMALL = "33333333-3333-4333-8333-333333333333";

const rooms = new Map<string, RoomInfo>([
  [
    ROOM,
    { id: ROOM, name: "Room 3", online: false, capacity: 8, archived: false },
  ],
  [
    ONLINE,
    {
      id: ONLINE,
      name: "Online 1",
      online: true,
      capacity: null,
      archived: false,
    },
  ],
  [
    SMALL,
    { id: SMALL, name: "Room 1", online: false, capacity: 2, archived: true },
  ],
]);

const time = (weekday: number, start: string, end: string, roomId = ROOM) => {
  const minutes = (value: string) => {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  };
  return {
    weekday,
    startMinute: minutes(start),
    endMinute: minutes(end),
    roomId,
  };
};

describe("lessonTimesSchema", () => {
  it("accepts up to seven non-overlapping rows, and none", () => {
    expect(parseInput(lessonTimesSchema, { times: [] }).ok).toBe(true);
    const result = parseInput(lessonTimesSchema, {
      times: [time(2, "17:00", "18:30"), time(4, "17:00", "18:30")],
    });
    expect(result).toEqual({
      ok: true,
      data: { times: [time(2, "17:00", "18:30"), time(4, "17:00", "18:30")] },
    });
  });

  it("puts the time-order error on the row's end", () => {
    const result = parseInput(lessonTimesSchema, {
      times: [time(2, "17:00", "18:30"), time(3, "18:00", "17:00")],
    });
    expect(result).toEqual({
      ok: false,
      fieldErrors: { "times.1.endMinute": { key: "validation.timeOrder" } },
    });
  });

  it("refuses two overlapping rows of the same group", () => {
    const result = parseInput(lessonTimesSchema, {
      times: [time(2, "17:00", "18:30"), time(2, "18:00", "19:00")],
    });
    expect(result).toEqual({
      ok: false,
      fieldErrors: {
        "times.1.startMinute": { key: "validation.lessonTimesOverlap" },
      },
    });
  });

  it("refuses more than seven rows, off-grid minutes and bad ids", () => {
    const eight = Array.from({ length: 8 }, (_, i) =>
      time(
        (i % 7) + 1,
        `${String(8 + i).padStart(2, "0")}:00`,
        `${String(8 + i).padStart(2, "0")}:45`,
      ),
    );
    expect(parseInput(lessonTimesSchema, { times: eight }).ok).toBe(false);
    expect(
      parseInput(lessonTimesSchema, {
        times: [{ ...time(1, "08:00", "09:00"), startMinute: 481 }],
      }).ok,
    ).toBe(false);
    expect(
      parseInput(lessonTimesSchema, {
        times: [{ ...time(1, "08:00", "09:00"), roomId: "nope" }],
      }).ok,
    ).toBe(false);
    expect(
      parseInput(lessonTimesSchema, {
        times: [{ ...time(1, "08:00", "09:00"), weekday: 8 }],
      }).ok,
    ).toBe(false);
  });
});

describe("firstOverlap", () => {
  it("finds the first row overlapping an earlier one; touching is fine", () => {
    expect(
      firstOverlap([time(1, "08:00", "09:00"), time(1, "09:00", "10:00")]),
    ).toBe(-1);
    expect(
      firstOverlap([
        time(1, "08:00", "09:00"),
        time(2, "08:00", "09:00"),
        time(1, "08:30", "08:45"),
      ]),
    ).toBe(2);
  });
});

describe("roomClashes", () => {
  const others = [
    { ...time(2, "17:30", "19:00"), groupId: "g2", groupName: "B1 Evening" },
    {
      ...time(2, "17:30", "19:00", ONLINE),
      groupId: "g3",
      groupName: "C1 Online",
    },
  ];

  it("blocks a physical room another group uses at an overlapping time", () => {
    expect(
      roomClashes(
        [time(4, "17:00", "18:30"), time(2, "17:00", "18:00")],
        others,
        rooms,
      ),
    ).toEqual([
      {
        index: 1,
        roomId: ROOM,
        otherGroupName: "B1 Evening",
        weekday: 2,
        startMinute: 17 * 60 + 30,
        endMinute: 19 * 60,
      },
    ]);
  });

  it("lets online rooms be shared and back-to-back lessons pass", () => {
    expect(
      roomClashes([time(2, "17:00", "18:00", ONLINE)], others, rooms),
    ).toEqual([]);
    expect(roomClashes([time(2, "16:00", "17:30")], others, rooms)).toEqual([]);
  });
});

describe("lessonTimeWarnings", () => {
  const school = {
    teachingWeekdays: [1, 2, 3, 4, 5],
    dayStartMinute: 8 * 60,
    dayEndMinute: 20 * 60,
  };

  it("warns about capacity, archived rooms, school days and hours", () => {
    expect(
      lessonTimeWarnings(
        [time(6, "07:30", "09:00", SMALL), time(2, "17:00", "18:30")],
        rooms,
        4,
        school,
      ),
    ).toEqual([
      { code: "ROOM_ARCHIVED", index: 0 },
      { code: "ROOM_CAPACITY", index: 0, capacity: 2, members: 4 },
      { code: "OUTSIDE_SCHOOL_DAYS", index: 0 },
      { code: "OUTSIDE_SCHOOL_HOURS", index: 0 },
    ]);
  });

  it("ignores capacity of online rooms", () => {
    expect(
      lessonTimeWarnings(
        [time(2, "17:00", "18:00", ONLINE)],
        rooms,
        40,
        school,
      ),
    ).toEqual([]);
  });
});

describe("labels", () => {
  it("merges the same time across days and sums the week", () => {
    const times = [
      time(4, "17:00", "18:30"),
      time(6, "10:00", "12:00"),
      time(2, "17:00", "18:30"),
    ];
    expect(compactLessonTimes(times)).toEqual([
      { weekdays: [2, 4], startMinute: 1020, endMinute: 1110 },
      { weekdays: [6], startMinute: 600, endMinute: 720 },
    ]);
    const short = (d: number) =>
      ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d];
    expect(lessonTimesLabel(times, short)).toBe(
      "Tue, Thu 17:00–18:30 · Sat 10:00–12:00",
    );
    expect(lessonTimesLabel([], short)).toBe("");
    expect(weeklyMinutes(times)).toBe(90 + 90 + 120);
  });
});
