import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../../messages/en-GB";
import type { Message } from "@/server/admin/result";

import {
  describeNotification,
  messageVariant,
  type NotificationFormat,
  type StoredNotification,
} from "./describe";
import type { Audience, NotificationParams, NotificationType } from "./rules";

const format: NotificationFormat = {
  date: (iso) => `D(${iso.slice(0, 10)})`,
  time: (iso) => `T(${iso.slice(11, 16)})`,
  day: (date) => `d(${date})`,
};

const t = createTranslator({ locale: "en-GB", messages });
const render = (message: Message): string => {
  const values: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(message.values ?? {})) {
    values[k] = typeof v === "object" ? render(v) : v;
  }
  return (t as unknown as (key: string, v: object) => string)(
    message.key,
    values,
  );
};

const lessonParams: NotificationParams = {
  group: "B1 Evening",
  lessonType: "GROUP",
  startsAt: "2026-10-22T15:00:00.000Z",
  endsAt: "2026-10-22T16:30:00.000Z",
};

const n = (
  type: NotificationType,
  audience: Audience,
  params: NotificationParams = {},
): StoredNotification => ({
  type,
  audience,
  params: { ...lessonParams, ...params },
  link: null,
});

const text = (notification: StoredNotification) => {
  const d = describeNotification(notification, format);
  return {
    title: render(d.title),
    details: d.details.map(render),
    icon: d.icon,
  };
};

describe("messageVariant", () => {
  it.each([
    ["LESSON_CANCELLED", "regular", {}, "teacher"],
    ["LESSON_CANCELLED", "substitute", {}, "teacher"],
    ["LESSON_CANCELLED", "student", {}, "student"],
    ["SUBSTITUTE_ASSIGNED", "teacher", {}, "regular"],
    ["SUBSTITUTE_ASSIGNED", "substitute", {}, "substitute"],
    [
      "REPLACEMENT_ENDED",
      "student",
      { outcome: "rejected" },
      "studentRejected",
    ],
    [
      "REPLACEMENT_ENDED",
      "student",
      { outcome: "cancelled" },
      "studentCancelled",
    ],
    ["TIMETABLE_CHANGED", "student", {}, "teacher"],
    ["TIMETABLE_PUBLISHED", "student", {}, "teacher"],
    ["REPLACEMENT_REVIEW_PENDING", "admin", {}, "admin"],
    ["AVAILABILITY_REQUEST_PENDING", "admin", {}, "admin"],
    [
      "AVAILABILITY_REQUEST_DECIDED",
      "teacher",
      { outcome: "approved" },
      "approved",
    ],
    [
      "AVAILABILITY_REQUEST_DECIDED",
      "teacher",
      { outcome: "rejected" },
      "rejected",
    ],
  ] as const)("%s for %s → %s", (type, audience, params, variant) => {
    expect(messageVariant(n(type, audience, params))).toBe(variant);
  });

  it("uses the room variant when only the room changed", () => {
    const params = {
      oldStartsAt: lessonParams.startsAt,
      oldEndsAt: lessonParams.endsAt,
      oldRoom: "Room 1",
      room: "Room 3",
    };
    expect(messageVariant(n("LESSON_MOVED", "student", params))).toBe(
      "studentRoom",
    );
    expect(messageVariant(n("LESSON_MOVED", "regular", params))).toBe(
      "teacherRoom",
    );
    expect(
      messageVariant(
        n("LESSON_MOVED", "teacher", {
          ...params,
          oldStartsAt: "2026-10-21T15:00:00.000Z",
        }),
      ),
    ).toBe("teacher");
  });
});

describe("describeNotification", () => {
  it("cancelled: title, translated reason", () => {
    expect(
      text(n("LESSON_CANCELLED", "teacher", { reason: "SCHOOL_CANCELLED" })),
    ).toEqual({
      title: "B1 Evening on D(2026-10-22) is cancelled",
      details: ["Reason: Cancelled by the school"],
      icon: "ban",
    });
  });

  it("a free-text cancel reason is shown as typed", () => {
    expect(
      text(
        n("LESSON_CANCELLED", "student", { reason: "Teacher on sick leave" }),
      ).details,
    ).toEqual(["Reason: Teacher on sick leave"]);
  });

  it("a 1-on-1 reads 'your lesson' for the student", () => {
    expect(
      text(
        n("LESSON_CANCELLED", "student", {
          lessonType: "ONE_ON_ONE",
          group: "Olga",
        }),
      ).title,
    ).toBe("Your lesson on D(2026-10-22) is cancelled");
    expect(
      text(
        n("SUBSTITUTE_ASSIGNED", "student", {
          lessonType: "ONE_ON_ONE",
          substitute: "Ana Kral",
        }),
      ).title,
    ).toBe("Ana Kral is teaching your lesson on D(2026-10-22)");
  });

  it("moved: new time in the title, old one in the detail", () => {
    const moved = text(
      n("LESSON_MOVED", "student", {
        oldStartsAt: "2026-10-21T15:00:00.000Z",
        oldEndsAt: "2026-10-21T16:30:00.000Z",
        oldRoom: "Room 1",
        room: "Room 1",
      }),
    );
    expect(moved.title).toBe("B1 Evening moved to D(2026-10-22), T(15:00)");
    expect(moved.details).toEqual(["Was D(2026-10-21), T(15:00)"]);
    const roomOnly = text(
      n("LESSON_MOVED", "teacher", {
        oldStartsAt: lessonParams.startsAt,
        oldEndsAt: lessonParams.endsAt,
        oldRoom: "Room 1",
        room: "Room 3",
      }),
    );
    expect(roomOnly).toEqual({
      title: "B1 Evening on D(2026-10-22) is now in Room 3",
      details: ["Was Room 1"],
      icon: "door-open",
    });
  });

  it("substitute copies per audience", () => {
    const params = {
      substitute: "Ana Kral",
      teacher: "Tomas Horvat",
      room: "Room 3",
    };
    expect(text(n("SUBSTITUTE_ASSIGNED", "substitute", params))).toEqual({
      title: "You're substituting in B1 Evening on D(2026-10-22)",
      details: ["For Tomas Horvat · T(15:00)–T(16:30) · Room 3"],
      icon: "user-round-cog",
    });
    expect(text(n("SUBSTITUTE_ASSIGNED", "regular", params)).title).toBe(
      "Ana Kral is covering your B1 Evening lesson on D(2026-10-22)",
    );
    expect(text(n("SUBSTITUTE_REMOVED", "regular", params))).toEqual({
      title: "You're teaching B1 Evening on D(2026-10-22) again",
      details: ["Ana Kral no longer covers it"],
      icon: "user-round-x",
    });
  });

  it("timetable changed lists the non-zero counts and the range", () => {
    expect(
      text(
        n("TIMETABLE_CHANGED", "student", {
          term: "Autumn 2026",
          added: 0,
          cancelled: 1,
          moved: 3,
          teacherChanged: 12,
          firstDate: "2026-11-03",
          lastDate: "2026-12-15",
        }),
      ),
    ).toEqual({
      title: "Your timetable for Autumn 2026 changed",
      details: [
        "3 moved",
        "1 cancelled",
        "12 with a new teacher",
        "d(2026-11-03) – d(2026-12-15)",
      ],
      icon: "calendar-days",
    });
  });

  it("review pending counts bookings", () => {
    expect(
      text(n("REPLACEMENT_REVIEW_PENDING", "admin", { count: 3 })).title,
    ).toBe("3 new replacement bookings to review");
  });

  it("availability requests name the teacher and carry the admin's note", () => {
    expect(
      text(
        n("AVAILABILITY_REQUEST_PENDING", "admin", {
          teacher: "Tomas",
          count: 1,
        }),
      ).title,
    ).toBe("Tomas asked to change their availability");
    expect(
      text(
        n("AVAILABILITY_REQUEST_PENDING", "admin", {
          teacher: "Tomas",
          count: 2,
        }),
      ).title,
    ).toBe("Tomas sent 2 availability changes to review");
    const decided = text(
      n("AVAILABILITY_REQUEST_DECIDED", "teacher", {
        outcome: "rejected",
        note: "Exam week",
      }),
    );
    expect(decided.title).toBe("The school declined your availability change");
    expect(decided.details).toEqual(["Note from the school: Exam week"]);
  });

  it("every type renders for every audience it is sent to", () => {
    const cases: [NotificationType, Audience, NotificationParams][] = [
      ["LESSON_CANCELLED", "teacher", { reason: "HOLIDAY" }],
      ["LESSON_CANCELLED", "student", { reason: "HOLIDAY" }],
      [
        "LESSON_MOVED",
        "regular",
        {
          oldStartsAt: "2026-10-20T10:00:00.000Z",
          oldEndsAt: "2026-10-20T11:00:00.000Z",
        },
      ],
      ["SUBSTITUTE_ASSIGNED", "student", { substitute: "A", teacher: "B" }],
      ["SUBSTITUTE_REMOVED", "substitute", { substitute: "A", teacher: "B" }],
      ["SUBSTITUTE_REMOVED", "student", { substitute: "A", teacher: "B" }],
      ["ABSENCE_REPORTED", "teacher", { student: "Cara", withCredit: "yes" }],
      ["ABSENCE_REPORTED", "student", { withCredit: "no" }],
      ["REPLACEMENT_BOOKED", "teacher", { student: "Cara", fromGroup: "B1 M" }],
      ["REPLACEMENT_BOOKED", "student", { fromGroup: "B1 M" }],
      ["REPLACEMENT_ENDED", "teacher", { student: "Cara", outcome: "moved" }],
      [
        "REPLACEMENT_ENDED",
        "student",
        { outcome: "rejected", creditBack: "yes", note: "Full" },
      ],
      [
        "REPLACEMENT_ENDED",
        "student",
        { outcome: "cancelled", creditBack: "no" },
      ],
      [
        "REPLACEMENT_MOVED",
        "student",
        {
          fromGroup: "B1 M",
          oldStartsAt: "2026-10-20T10:00:00.000Z",
          note: null,
        },
      ],
      ["REPLACEMENT_REVIEW_PENDING", "admin", { count: 1 }],
      [
        "TIMETABLE_PUBLISHED",
        "teacher",
        { term: "Autumn", firstStartsAt: "2026-10-20T10:00:00.000Z" },
      ],
      [
        "TIMETABLE_PUBLISHED",
        "student",
        { term: "Autumn", firstStartsAt: null },
      ],
      ["CALENDAR_FEED_REVOKED", "student", {}],
      ["AVAILABILITY_REQUEST_PENDING", "admin", { teacher: "T", count: 1 }],
      ["AVAILABILITY_REQUEST_DECIDED", "teacher", { outcome: "approved" }],
      [
        "AVAILABILITY_REQUEST_DECIDED",
        "teacher",
        { outcome: "rejected", note: "No" },
      ],
    ];
    for (const [type, audience, params] of cases) {
      const out = text(n(type, audience, params));
      expect(out.title, `${type}/${audience}`).not.toMatch(
        /notifications\.|\{/,
      );
      for (const d of out.details)
        expect(d, `${type}/${audience}`).not.toMatch(/notifications\.|\{/);
    }
  });
});
