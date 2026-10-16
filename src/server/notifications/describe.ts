// How a stored notification reads (docs/design/notifications-substitutes.md
// §4.4, §8): the message variant for the reader's audience, the title and
// detail messages with their ICU values, and where the link leads. Pure:
// the caller passes formatters in the school's time zone, so text is
// rendered at read time from `type` + `params` and nothing English is
// stored.

import type { Message } from "@/server/admin/result";

import type {
  Audience,
  NotificationLink,
  NotificationParams,
  NotificationType,
} from "./rules";

export type StoredNotification = {
  type: NotificationType;
  audience: Audience;
  params: NotificationParams;
  link: NotificationLink | null;
};

/** Date and time formatters in the school's time zone. */
export type NotificationFormat = {
  /** An instant's local date, e.g. "Mon 20 Oct". */
  date(instant: string): string;
  /** An instant's local time, e.g. "17:00". */
  time(instant: string): string;
  /** A calendar date "YYYY-MM-DD", e.g. "3 Nov". */
  day(isoDate: string): string;
};

export type NotificationIcon =
  | "ban"
  | "calendar-clock"
  | "door-open"
  | "user-round-cog"
  | "user-round-x"
  | "calendar-x"
  | "repeat"
  | "calendar-check"
  | "calendar-days"
  | "link";

export type NotificationText = {
  title: Message;
  details: Message[];
  icon: NotificationIcon;
};

const NS = "notifications";

const s = (value: unknown): string =>
  typeof value === "string" ? value : value == null ? "" : String(value);
const n = (value: unknown): number => (typeof value === "number" ? value : 0);

const isTeacherAudience = (audience: Audience) =>
  audience === "teacher" || audience === "regular" || audience === "substitute";

/** Only the room changed: same start and end (§4.4 "now in {room}"). */
export function isRoomOnlyMove(params: NotificationParams): boolean {
  return (
    params.oldStartsAt === params.startsAt &&
    params.oldEndsAt === params.endsAt &&
    params.oldRoom !== params.room
  );
}

/**
 * The key under `notifications.types.<TYPE>` for this reader (§8 "Variant
 * fallback"): teacher audiences without their own key use `teacher`, and
 * the timetable and calendar types use `teacher` for students too.
 */
export function messageVariant(n: StoredNotification): string {
  const { type, audience, params } = n;
  switch (type) {
    case "LESSON_MOVED": {
      const base = audience === "student" ? "student" : "teacher";
      return isRoomOnlyMove(params) ? `${base}Room` : base;
    }
    case "SUBSTITUTE_ASSIGNED":
    case "SUBSTITUTE_REMOVED":
      return audience === "teacher" ? "regular" : audience;
    case "REPLACEMENT_ENDED":
      if (audience !== "student") return "teacher";
      return params.outcome === "rejected"
        ? "studentRejected"
        : "studentCancelled";
    case "REPLACEMENT_MOVED":
      return "student";
    case "REPLACEMENT_REVIEW_PENDING":
      return "admin";
    case "TIMETABLE_PUBLISHED":
    case "TIMETABLE_CHANGED":
    case "CALENDAR_FEED_REVOKED":
      return "teacher";
    default:
      return isTeacherAudience(audience) || audience === "admin"
        ? "teacher"
        : "student";
  }
}

const ICONS: Record<NotificationType, NotificationIcon> = {
  LESSON_CANCELLED: "ban",
  LESSON_MOVED: "calendar-clock",
  SUBSTITUTE_ASSIGNED: "user-round-cog",
  SUBSTITUTE_REMOVED: "user-round-x",
  ABSENCE_REPORTED: "calendar-x",
  REPLACEMENT_BOOKED: "repeat",
  REPLACEMENT_ENDED: "repeat",
  REPLACEMENT_MOVED: "repeat",
  REPLACEMENT_REVIEW_PENDING: "repeat",
  TIMETABLE_PUBLISHED: "calendar-check",
  TIMETABLE_CHANGED: "calendar-days",
  CALENDAR_FEED_REVOKED: "link",
};

const msg = (key: string, values?: Message["values"]): Message =>
  values ? { key: `${NS}.${key}`, values } : { key: `${NS}.${key}` };

/** Title, detail lines and icon of one notification for its reader. */
export function describeNotification(
  notification: StoredNotification,
  format: NotificationFormat,
): NotificationText {
  const { type, params } = notification;
  const variant = messageVariant(notification);
  const at = (key: string) => (params[key] ? format.date(s(params[key])) : "");
  const time = (start: string, end: string) =>
    params[start] && params[end]
      ? `${format.time(s(params[start]))}–${format.time(s(params[end]))}`
      : "";
  const values: Record<string, string | number> = {
    group: s(params.group),
    lessonType: s(params.lessonType) || "GROUP",
    date: at("startsAt"),
    time: time("startsAt", "endsAt"),
    room: s(params.room),
    substitute: s(params.substitute),
    teacher: s(params.teacher),
    student: s(params.student),
    fromGroup: s(params.fromGroup),
    count: n(params.count),
    term: s(params.term),
  };
  const details: Message[] = [];
  const roomTime = () =>
    values.room
      ? msg("detail.timeRoom", { time: values.time, room: values.room })
      : msg("detail.time", { time: values.time });

  switch (type) {
    case "LESSON_CANCELLED":
      if (params.reason) {
        details.push(
          msg("detail.reason", {
            reason: { key: `scheduling.cancelReasons.${s(params.reason)}` },
          }),
        );
      }
      break;
    case "LESSON_MOVED":
      if (isRoomOnlyMove(params)) {
        details.push(msg("detail.wasRoom", { oldRoom: s(params.oldRoom) }));
      } else {
        values.time = format.time(s(params.startsAt));
        details.push(
          msg("detail.was", {
            oldDate: at("oldStartsAt"),
            oldTime: format.time(s(params.oldStartsAt)),
          }),
        );
      }
      break;
    case "SUBSTITUTE_ASSIGNED":
      details.push(
        variant === "substitute"
          ? values.room
            ? msg("detail.forTeacher", {
                teacher: values.teacher,
                time: values.time,
                room: values.room,
              })
            : msg("detail.forTeacherNoRoom", {
                teacher: values.teacher,
                time: values.time,
              })
          : roomTime(),
      );
      break;
    case "SUBSTITUTE_REMOVED":
      if (variant === "regular") {
        details.push(
          msg("detail.noLongerCovers", { substitute: values.substitute }),
        );
      }
      break;
    case "ABSENCE_REPORTED":
      if (variant === "student") {
        details.push(
          msg("detail.withCredit", { withCredit: s(params.withCredit) }),
        );
      }
      break;
    case "REPLACEMENT_BOOKED":
      details.push(
        variant === "student"
          ? msg("detail.forMissed", { fromGroup: values.fromGroup })
          : msg("detail.fromGroup", { fromGroup: values.fromGroup }),
      );
      break;
    case "REPLACEMENT_ENDED":
      if (variant === "teacher") {
        details.push(msg("detail.outcome", { outcome: s(params.outcome) }));
      } else {
        if (variant === "studentRejected" && params.note) {
          details.push(msg("detail.note", { note: s(params.note) }));
        }
        details.push(
          msg("detail.creditBack", { creditBack: s(params.creditBack) }),
        );
      }
      break;
    case "REPLACEMENT_MOVED":
      details.push(
        msg("detail.movedFrom", {
          fromGroup: values.fromGroup,
          oldDate: at("oldStartsAt"),
        }),
      );
      if (params.note)
        details.push(msg("detail.note", { note: s(params.note) }));
      break;
    case "REPLACEMENT_REVIEW_PENDING":
      break;
    case "TIMETABLE_PUBLISHED":
      details.push(
        params.firstStartsAt
          ? msg("detail.firstLesson", {
              date: format.date(s(params.firstStartsAt)),
              time: format.time(s(params.firstStartsAt)),
            })
          : msg("detail.noLessons"),
      );
      break;
    case "TIMETABLE_CHANGED":
      for (const key of [
        "added",
        "moved",
        "cancelled",
        "teacherChanged",
      ] as const) {
        if (n(params[key]) > 0)
          details.push(msg(`detail.${key}`, { count: n(params[key]) }));
      }
      if (params.firstDate && params.lastDate) {
        details.push(
          params.firstDate === params.lastDate
            ? msg("detail.day", { date: format.day(s(params.firstDate)) })
            : msg("detail.range", {
                from: format.day(s(params.firstDate)),
                to: format.day(s(params.lastDate)),
              }),
        );
      }
      break;
    case "CALENDAR_FEED_REVOKED":
      details.push(msg("detail.feedRevoked"));
      break;
  }

  return {
    title: msg(`types.${type}.${variant}`, values),
    details,
    icon:
      type === "LESSON_MOVED" && isRoomOnlyMove(params)
        ? "door-open"
        : ICONS[type],
  };
}

/** The trailing "Open …" label for a link kind (§4.3). */
export function openLabel(link: NotificationLink): Message {
  switch (link.kind) {
    case "lesson":
      return msg("open.lesson");
    case "timetable":
      return msg("open.timetable");
    case "replacementReview":
      return msg("open.review");
    case "absences":
      return msg("open.absences");
    case "calendarFeed":
      return msg("open.calendar");
  }
}
