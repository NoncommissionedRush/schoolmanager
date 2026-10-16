// The iCalendar text of a calendar feed (docs/architecture/phase5-rules.md
// §5.3). Pure: lessons in, RFC 5545 text out. The caller passes the lessons
// already limited to the viewer, a translator for `calendarFeed.*` and
// `now`; nothing here reads the database or the clock.
//
// A feed URL is easy to leak, so the input type has no field for other
// students, rosters, notes, absence reasons, ratings, logs, homework or an
// online room's meeting link: they can't end up in the output.

import { CANCEL_REASON_CODES } from "@/server/notifications/describe";

/** Lessons from this many days ago … */
export const FEED_PAST_DAYS = 30;
/** … to this many days ahead. */
export const FEED_FUTURE_DAYS = 180;

/** `SEQUENCE` counts seconds from here to `Lesson.updatedAt`. */
const SEQUENCE_EPOCH = Date.UTC(2026, 0, 1);

/** One lesson as the feed needs it, already relative to the viewer. */
export type FeedLesson = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  updatedAt: Date;
  cancelled: boolean;
  /** A code (`scheduling.cancelReasons.*`) or free text typed by an admin. */
  cancelReason: string | null;
  groupName: string;
  lessonType: "GROUP" | "ONE_ON_ONE";
  level: string;
  room: string | null;
  /** The regular teacher. */
  teacherName: string;
  substituteName: string | null;
  /** How the viewer relates to the lesson. */
  viewerIs: "regular" | "substitute" | "student";
  /** The student reported an absence (the group lesson still runs). */
  notAttending: boolean;
};

/** Translates a full message key, e.g. `calendarFeed.event.cancelled`. */
export type FeedTranslate = (
  key: string,
  values?: Record<string, string>,
) => string;

export type FeedViewer = {
  role: "TEACHER" | "STUDENT";
  schoolName: string;
  timeZone: string;
  /** Absolute origin for lesson links, e.g. "https://app.example". */
  baseUrl: string;
};

export type FeedCase =
  | "normal"
  | "substituteFor"
  | "substituting"
  | "coveredBy"
  | "cancelled"
  | "notAttending";

/** Which row of the §5.3 table a lesson is, for this viewer. */
export function feedCase(lesson: FeedLesson): FeedCase {
  if (lesson.cancelled) return "cancelled";
  if (lesson.viewerIs === "student") {
    if (lesson.notAttending) return "notAttending";
    return lesson.substituteName ? "substituteFor" : "normal";
  }
  if (!lesson.substituteName) return "normal";
  return lesson.viewerIs === "substitute" ? "substituting" : "coveredBy";
}

/** `YYYYMMDDTHHMMSSZ`. */
export function icsDateTime(instant: Date): string {
  return instant
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

/** RFC 5545 §3.3.11 TEXT escaping. */
export function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();

/**
 * RFC 5545 §3.1 folding: lines longer than 75 octets continue on the next
 * line after CRLF + one space. Never splits a UTF-8 character.
 */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  // The first line holds 75 octets; continuation lines 74 plus the space.
  let limit = 75;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > limit) {
      parts.push(current);
      current = "";
      size = 0;
      limit = 74;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/** Seconds from 2026-01-01 to `updatedAt`, never negative. */
export function sequenceOf(updatedAt: Date): number {
  return Math.max(0, Math.floor((updatedAt.getTime() - SEQUENCE_EPOCH) / 1000));
}

function lessonPath(role: FeedViewer["role"], lessonId: string) {
  return `/${role === "TEACHER" ? "teacher" : "student"}/lessons/${lessonId}`;
}

function vevent(
  lesson: FeedLesson,
  viewer: FeedViewer,
  t: FeedTranslate,
  now: Date,
): string[] {
  const kind = feedCase(lesson);
  // A student's 1-on-1 "group" is their own name: show the lesson type.
  const group =
    lesson.viewerIs === "student" && lesson.lessonType === "ONE_ON_ONE"
      ? t(`calendarFeed.event.type.${lesson.lessonType}`)
      : lesson.groupName;
  const substitute = lesson.substituteName ?? "";
  const summary = {
    normal: group,
    substituteFor: t("calendarFeed.event.substituteFor", { group, substitute }),
    substituting: t("calendarFeed.event.substituting", { group }),
    coveredBy: t("calendarFeed.event.coveredBy", { group, substitute }),
    cancelled: t("calendarFeed.event.cancelled", { group }),
    notAttending: t("calendarFeed.event.notAttending", { group }),
  }[kind];

  const url = `${viewer.baseUrl}${lessonPath(viewer.role, lesson.id)}`;
  const description: string[] = [];
  if (kind === "cancelled" && lesson.cancelReason) {
    const reason = CANCEL_REASON_CODES.has(lesson.cancelReason)
      ? t(`scheduling.cancelReasons.${lesson.cancelReason}`)
      : lesson.cancelReason;
    description.push(t("calendarFeed.event.reason", { reason }));
  }
  description.push(
    `${t(`calendarFeed.event.type.${lesson.lessonType}`)} · ${t("calendarFeed.event.level", { level: lesson.level })}`,
  );
  if (kind === "substituting") {
    description.push(
      t("calendarFeed.event.for", { teacher: lesson.teacherName }),
    );
  } else if (lesson.substituteName) {
    description.push(
      t("calendarFeed.event.insteadOf", {
        substitute,
        teacher: lesson.teacherName,
      }),
    );
  } else {
    description.push(
      t("calendarFeed.event.teacher", { teacher: lesson.teacherName }),
    );
  }
  if (kind === "notAttending")
    description.push(t("calendarFeed.event.stillRuns"));
  description.push(url);

  const transparent =
    kind === "cancelled" || kind === "coveredBy" || kind === "notAttending";
  return [
    "BEGIN:VEVENT",
    `UID:lesson-${lesson.id}@schoolmanager`,
    `DTSTAMP:${icsDateTime(now)}`,
    `DTSTART:${icsDateTime(lesson.startsAt)}`,
    `DTEND:${icsDateTime(lesson.endsAt)}`,
    `LAST-MODIFIED:${icsDateTime(lesson.updatedAt)}`,
    `SEQUENCE:${sequenceOf(lesson.updatedAt)}`,
    `SUMMARY:${escapeText(summary)}`,
    ...(lesson.room ? [`LOCATION:${escapeText(lesson.room)}`] : []),
    `URL:${url}`,
    `DESCRIPTION:${escapeText(description.join("\n"))}`,
    `STATUS:${kind === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
    `TRANSP:${transparent ? "TRANSPARENT" : "OPAQUE"}`,
    "END:VEVENT",
  ];
}

/**
 * The whole feed: one `VEVENT` per lesson (sorted by start, then id), UTC
 * instants, CRLF line endings and 75-octet folding.
 */
export function buildFeed(
  lessons: readonly FeedLesson[],
  viewer: FeedViewer,
  t: FeedTranslate,
  now: Date,
): string {
  const sorted = [...lessons].sort(
    (a, b) =>
      a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id),
  );
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//schoolmanager//calendar feed//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(t("calendarFeed.calendarName", { school: viewer.schoolName }))}`,
    `X-WR-TIMEZONE:${viewer.timeZone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...sorted.flatMap((lesson) => vevent(lesson, viewer, t, now)),
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
