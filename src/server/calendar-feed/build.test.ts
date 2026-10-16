import ICAL from "ical.js";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../../messages/en-GB";

import {
  buildFeed,
  escapeText,
  type FeedLesson,
  type FeedTranslate,
  type FeedViewer,
  foldLine,
  icsDateTime,
  sequenceOf,
} from "./build";

const intl = createTranslator({ locale: "en-GB", messages });
const t: FeedTranslate = (key, values) =>
  (intl as unknown as (k: string, v?: object) => string)(key, values);

const NOW = new Date("2026-10-20T08:00:00Z");
const TEACHER: FeedViewer = {
  role: "TEACHER",
  schoolName: "Lingua Bratislava",
  timeZone: "Europe/Bratislava",
  baseUrl: "https://school.example",
};
const STUDENT: FeedViewer = { ...TEACHER, role: "STUDENT" };

const lesson = (overrides: Partial<FeedLesson> = {}): FeedLesson => ({
  id: "11111111-1111-4111-8111-111111111111",
  startsAt: new Date("2026-10-22T15:00:00Z"),
  endsAt: new Date("2026-10-22T16:30:00Z"),
  updatedAt: new Date("2026-10-01T10:00:00Z"),
  cancelled: false,
  cancelReason: null,
  groupName: "B1 Evening",
  lessonType: "GROUP",
  level: "B1",
  room: "Room 2",
  teacherName: "Tomas Horvat",
  substituteName: null,
  viewerIs: "regular",
  notAttending: false,
  ...overrides,
});

/** Parses with ical.js and returns the first VEVENT's properties. */
function event(text: string) {
  const comp = new ICAL.Component(ICAL.parse(text));
  const vevent = comp.getFirstSubcomponent("vevent")!;
  const get = (name: string) => vevent.getFirstPropertyValue(name);
  return {
    calendar: comp,
    summary: get("summary") as string,
    status: get("status") as string,
    transp: get("transp") as string,
    description: get("description") as string,
    location: get("location") as string | null,
    url: get("url") as string,
    uid: get("uid") as string,
    sequence: get("sequence") as number,
  };
}

describe("feed cases (§5.3)", () => {
  it("normal lesson", () => {
    const e = event(buildFeed([lesson()], TEACHER, t, NOW));
    expect(e).toMatchObject({
      summary: "B1 Evening",
      status: "CONFIRMED",
      transp: "OPAQUE",
      location: "Room 2",
      url: "https://school.example/teacher/lessons/11111111-1111-4111-8111-111111111111",
      uid: "lesson-11111111-1111-4111-8111-111111111111@schoolmanager",
    });
    expect(e.description).toContain("Teacher: Tomas Horvat");
    expect(e.description).toContain("Level: B1");
  });

  it("substituted, student viewing", () => {
    const e = event(
      buildFeed(
        [lesson({ viewerIs: "student", substituteName: "Ana Kral" })],
        STUDENT,
        t,
        NOW,
      ),
    );
    expect(e.summary).toBe("B1 Evening (substitute: Ana Kral)");
    expect(e).toMatchObject({ status: "CONFIRMED", transp: "OPAQUE" });
    expect(e.description).toContain(
      "Teacher: Ana Kral, instead of Tomas Horvat",
    );
    expect(e.url).toContain("/student/lessons/");
  });

  it("substituted, substitute viewing", () => {
    const e = event(
      buildFeed(
        [lesson({ viewerIs: "substitute", substituteName: "Ana Kral" })],
        TEACHER,
        t,
        NOW,
      ),
    );
    expect(e.summary).toBe("Substituting: B1 Evening");
    expect(e).toMatchObject({ status: "CONFIRMED", transp: "OPAQUE" });
    expect(e.description).toContain("For Tomas Horvat");
  });

  it("substituted, regular teacher viewing", () => {
    const e = event(
      buildFeed(
        [lesson({ viewerIs: "regular", substituteName: "Ana Kral" })],
        TEACHER,
        t,
        NOW,
      ),
    );
    expect(e.summary).toBe("Covered by Ana Kral: B1 Evening");
    expect(e).toMatchObject({ status: "CONFIRMED", transp: "TRANSPARENT" });
  });

  it("cancelled, with a translated reason code", () => {
    const e = event(
      buildFeed(
        [lesson({ cancelled: true, cancelReason: "HOLIDAY" })],
        TEACHER,
        t,
        NOW,
      ),
    );
    expect(e.summary).toBe("Cancelled: B1 Evening");
    expect(e).toMatchObject({ status: "CANCELLED", transp: "TRANSPARENT" });
    expect(e.description).toContain("Reason: Holiday");
  });

  it("cancelled wins over a substitute or an absence", () => {
    const e = event(
      buildFeed(
        [
          lesson({
            cancelled: true,
            cancelReason: "Teacher ill",
            viewerIs: "student",
            notAttending: true,
            substituteName: "Ana Kral",
          }),
        ],
        STUDENT,
        t,
        NOW,
      ),
    );
    expect(e.summary).toBe("Cancelled: B1 Evening");
    expect(e.description).toContain("Reason: Teacher ill");
  });

  it("student reported an absence", () => {
    const e = event(
      buildFeed(
        [lesson({ viewerIs: "student", notAttending: true })],
        STUDENT,
        t,
        NOW,
      ),
    );
    expect(e.summary).toBe("Not attending: B1 Evening");
    expect(e).toMatchObject({ status: "CONFIRMED", transp: "TRANSPARENT" });
  });

  it("a student's 1-on-1 shows the lesson type, not their own name", () => {
    const e = event(
      buildFeed(
        [
          lesson({
            viewerIs: "student",
            lessonType: "ONE_ON_ONE",
            groupName: "Jana Novak",
          }),
        ],
        STUDENT,
        t,
        NOW,
      ),
    );
    expect(e.summary).toBe("1-on-1 lesson");
    expect(e.description).not.toContain("Jana Novak");
  });

  it("the teacher's 1-on-1 shows the student's name", () => {
    const e = event(
      buildFeed(
        [lesson({ lessonType: "ONE_ON_ONE", groupName: "Jana Novak" })],
        TEACHER,
        t,
        NOW,
      ),
    );
    expect(e.summary).toBe("Jana Novak");
  });

  it("omits LOCATION without a room", () => {
    expect(
      event(buildFeed([lesson({ room: null })], TEACHER, t, NOW)).location,
    ).toBeNull();
  });
});

describe("calendar", () => {
  it("has a name and time zone hint, UTC instants and no VTIMEZONE", () => {
    const text = buildFeed([lesson()], TEACHER, t, NOW);
    const { calendar } = event(text);
    expect(calendar.getFirstPropertyValue("x-wr-calname")).toBe(
      "Lingua Bratislava — my lessons",
    );
    expect(calendar.getFirstPropertyValue("x-wr-timezone")).toBe(
      "Europe/Bratislava",
    );
    expect(text).toContain("DTSTART:20261022T150000Z\r\n");
    expect(text).toContain("DTEND:20261022T163000Z\r\n");
    expect(text).toContain("DTSTAMP:20261020T080000Z\r\n");
    expect(text).not.toContain("VTIMEZONE");
  });

  it("uses CRLF line endings only", () => {
    const text = buildFeed([lesson()], TEACHER, t, NOW);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("an empty feed is a valid calendar", () => {
    const text = buildFeed([], TEACHER, t, NOW);
    const comp = new ICAL.Component(ICAL.parse(text));
    expect(comp.getAllSubcomponents("vevent")).toHaveLength(0);
  });

  it("sorts events by start, independent of input order", () => {
    const a = lesson({ id: "a", startsAt: new Date("2026-10-23T10:00:00Z") });
    const b = lesson({ id: "b" });
    expect(buildFeed([a, b], TEACHER, t, NOW)).toBe(
      buildFeed([b, a], TEACHER, t, NOW),
    );
  });
});

describe("stable UIDs and SEQUENCE", () => {
  it("keeps the UID when a lesson moves and increases SEQUENCE", () => {
    const before = event(buildFeed([lesson()], TEACHER, t, NOW));
    const after = event(
      buildFeed(
        [
          lesson({
            startsAt: new Date("2026-10-23T15:00:00Z"),
            endsAt: new Date("2026-10-23T16:30:00Z"),
            updatedAt: new Date("2026-10-19T10:00:00Z"),
          }),
        ],
        TEACHER,
        t,
        NOW,
      ),
    );
    expect(after.uid).toBe(before.uid);
    expect(after.sequence).toBeGreaterThan(before.sequence);
  });

  it("SEQUENCE counts seconds from 2026-01-01 and is never negative", () => {
    expect(sequenceOf(new Date("2026-01-01T00:01:00Z"))).toBe(60);
    expect(sequenceOf(new Date("2025-06-01T00:00:00Z"))).toBe(0);
    // Fits a signed 32-bit int for decades.
    expect(sequenceOf(new Date("2090-01-01T00:00:00Z"))).toBeLessThan(2 ** 31);
  });
});

describe("RFC 5545 text", () => {
  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeText("a\\b;c,d\ne\r\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
  });

  it("round-trips escaped text through a parser", () => {
    const e = event(
      buildFeed(
        [
          lesson({
            groupName: "B1; Evening, \\ Group",
            room: "Room 2, floor 1",
          }),
        ],
        TEACHER,
        t,
        NOW,
      ),
    );
    expect(e.summary).toBe("B1; Evening, \\ Group");
    expect(e.location).toBe("Room 2, floor 1");
  });

  it("folds lines over 75 octets without splitting characters", () => {
    const line = `SUMMARY:${"Žltá ".repeat(40)}`;
    const folded = foldLine(line);
    const parts = folded.split("\r\n");
    const encoder = new TextEncoder();
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
    }
    expect(parts.slice(1).every((p) => p.startsWith(" "))).toBe(true);
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join("")).toBe(line);
  });

  it("leaves short lines alone", () => {
    expect(foldLine("VERSION:2.0")).toBe("VERSION:2.0");
  });

  it("long folded values parse back whole", () => {
    const name = "A very long group name ".repeat(8).trim();
    expect(
      event(buildFeed([lesson({ groupName: name })], TEACHER, t, NOW)).summary,
    ).toBe(name);
  });

  it("formats UTC date-times", () => {
    expect(icsDateTime(new Date("2026-03-29T01:30:05.123Z"))).toBe(
      "20260329T013005Z",
    );
  });
});

describe("never in a feed", () => {
  it("has no input for notes, rosters, reasons, ratings or meeting links", () => {
    // The input type has no such fields; extra properties on a lesson
    // object never reach the output.
    const leaky = {
      ...lesson({ viewerIs: "student" }),
      meetingUrl: "https://meet.example/secret-room",
      teacherNotes: "Struggles with the past tense",
      absenceReason: "Doctor's appointment",
      students: ["Other Student"],
      rating: 1,
      homework: "Workbook p. 12",
    } as FeedLesson;
    const text = buildFeed([leaky], STUDENT, t, NOW);
    for (const secret of [
      "meet.example",
      "past tense",
      "Doctor",
      "Other Student",
      "Workbook",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
