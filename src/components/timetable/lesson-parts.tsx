"use client";

import { cn } from "cn";
import {
  Ban,
  CalendarX,
  Repeat,
  User,
  UserRoundCog,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";

import type { LessonView, ViewerKind } from "@/server/timetable/week";

import { formatMinutes } from "./format";

export type LessonTone =
  | "group"
  | "individual"
  | "substitute"
  | "cancelled"
  | "covered"
  | "notAttending"
  | "replacement";

/** The signed-in student cancelled this lesson (absences.md §5.8). */
export const isNotAttending = (lesson: LessonView) =>
  lesson.attendance?.cancelled != null;

/** The signed-in student's replacement or rescheduled lesson (§5.8). */
export const isBooking = (lesson: LessonView) =>
  lesson.attendance?.booking != null && lesson.status !== "CANCELLED";

/** Token family of a lesson block (timetable.md §6.2). */
export function lessonTone(lesson: LessonView): LessonTone {
  if (isNotAttending(lesson)) return "notAttending";
  if (lesson.status === "CANCELLED") return "cancelled";
  if (isBooking(lesson)) return "replacement";
  if (lesson.teacherRole === "covered") return "covered";
  if (lesson.substitute) return "substitute";
  return lesson.group.type === "ONE_ON_ONE" ? "individual" : "group";
}

export const toneClasses: Record<LessonTone, string> = {
  group: "border-lesson-group bg-lesson-group-surface text-lesson-group-text",
  individual:
    "border-lesson-individual bg-lesson-individual-surface text-lesson-individual-text",
  substitute:
    "border-lesson-substitute bg-lesson-substitute-surface text-lesson-substitute-text",
  cancelled:
    "border-dashed border-lesson-cancelled bg-lesson-cancelled-surface text-lesson-cancelled-text",
  covered:
    "border-lesson-cancelled bg-lesson-cancelled-surface text-lesson-cancelled-text",
  notAttending:
    "border-lesson-cancelled bg-lesson-cancelled-surface text-lesson-cancelled-text",
  replacement:
    "border-lesson-replacement bg-lesson-replacement-surface text-lesson-replacement-text",
};

export function ToneIcon({
  tone,
  type,
}: {
  tone: LessonTone;
  type: "GROUP" | "ONE_ON_ONE";
}) {
  const Icon =
    tone === "notAttending"
      ? CalendarX
      : tone === "replacement"
        ? Repeat
        : tone === "cancelled"
          ? Ban
          : tone === "substitute" || tone === "covered"
            ? UserRoundCog
            : type === "ONE_ON_ONE"
              ? User
              : Users;
  return <Icon aria-hidden="true" className="size-3.5 shrink-0" />;
}

/** The texts a lesson shows for a role (timetable.md §6.2). */
export function useLessonText(role: ViewerKind) {
  const t = useTranslations("timetable");
  const ta = useTranslations("absences");
  const tr = useTranslations("replacements");
  const ts = useTranslations("reschedule");
  return (lesson: LessonView) => {
    const time = `${formatMinutes(lesson.startMinute)}–${formatMinutes(lesson.endMinute)}`;
    const oneOnOne = lesson.group.type === "ONE_ON_ONE";
    const title =
      oneOnOne && role === "STUDENT"
        ? t("oneOnOneWith", { teacher: lesson.teacher.name })
        : oneOnOne && lesson.students?.length === 1
          ? lesson.students[0].name
          : lesson.group.name;
    const room = lesson.room?.name ?? null;
    let people: string | null = null;
    if (lesson.teacherRole === "substituting") {
      people = t("substitute.for", { teacher: lesson.teacher.name });
    } else if (lesson.teacherRole === "covered" && lesson.substitute) {
      people = t("substitute.coveredBy", {
        substitute: lesson.substitute.name,
      });
    } else if (lesson.substitute && role !== "TEACHER") {
      people = t("substitute.instead", {
        substitute: lesson.substitute.name,
        teacher: lesson.teacher.name,
      });
    } else if (role === "ADMIN") {
      people = lesson.teacher.name;
    } else if (role === "TEACHER") {
      people = lesson.level;
    }
    const subtitle = [room, people].filter(Boolean).join(" · ");
    const badges: string[] = [];
    if (isNotAttending(lesson)) badges.push(ta("notAttending"));
    else if (lesson.status === "CANCELLED") {
      badges.push(t("status.cancelled"));
    } else if (isBooking(lesson)) {
      badges.push(
        lesson.attendance!.booking!.kind === "replacement"
          ? tr("badge")
          : ts("badge"),
      );
    }
    if (lesson.teacherRole === "substituting")
      badges.push(t("substitute.youAre"));
    else if (lesson.substitute && lesson.teacherRole !== "covered") {
      badges.push(t("substitute.badge"));
    }
    const typeText = oneOnOne ? t("type.oneOnOne") : t("type.group");
    return { time, title, subtitle, badges, typeText };
  };
}

/** A lesson's block content (grid) or card content (agenda list). */
export function LessonContent({
  lesson,
  role,
  compact,
  card,
}: {
  lesson: LessonView;
  role: ViewerKind;
  compact?: boolean;
  card?: boolean;
}) {
  const text = useLessonText(role)(lesson);
  const tone = lessonTone(lesson);
  return (
    <span className="flex min-w-0 flex-col gap-0.5 text-left">
      <span className="flex items-center gap-1 text-xs">
        <ToneIcon tone={tone} type={lesson.group.type} />
        <span
          className={cn(
            "tabular-nums",
            lesson.status === "CANCELLED" &&
              !isNotAttending(lesson) &&
              "line-through",
          )}
        >
          {text.time}
        </span>
        <span className="sr-only">{text.typeText}</span>
        {text.badges.map((badge) => (
          <span
            key={badge}
            className="ml-auto rounded-sm bg-background/70 px-1 text-[0.65rem] font-medium"
          >
            {badge}
          </span>
        ))}
      </span>
      <span
        className={cn("truncate font-semibold", card ? "text-base" : "text-xs")}
      >
        {text.title}
      </span>
      {!compact && text.subtitle && (
        <span className={cn("truncate", card ? "text-sm" : "text-xs")}>
          {text.subtitle}
        </span>
      )}
    </span>
  );
}
