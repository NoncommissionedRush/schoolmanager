"use client";

import {
  Ban,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  NotebookPen,
  User,
  UserRoundCog,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { formatMinutes, useDateFormat } from "@/components/timetable/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";

export type LessonHeaderData = {
  group: { name: string; type: "GROUP" | "ONE_ON_ONE" };
  level: string;
  date: string;
  startMinute: number;
  endMinute: number;
  cancelReason: string | null;
  room: { name: string; online: boolean; meetingUrl: string | null } | null;
  badge: "cancelled" | "noLog" | null;
};

function NavButton({
  href,
  label,
  children,
}: {
  href: string | null;
  label: string;
  children: ReactNode;
}) {
  if (!href) {
    return (
      <Button variant="outline" size="icon" disabled aria-label={label}>
        {children}
      </Button>
    );
  }
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className={buttonVariants({ variant: "outline", size: "icon" })}
    >
      {children}
    </Link>
  );
}

/**
 * Lesson page header (lessons.md §5.2): back link, group name, meta line,
 * status badge, previous/next lesson of the group, then banners.
 */
export function LessonHeader({
  lesson,
  back,
  previousHref,
  nextHref,
  banners,
}: {
  lesson: LessonHeaderData;
  back: { href: string; label: string };
  previousHref: string | null;
  nextHref: string | null;
  banners?: ReactNode;
}) {
  const t = useTranslations("lessons");
  const tt = useTranslations("timetable");
  const tr = useTranslations("scheduling.cancelReasons");
  const tc = useTranslations("common");
  const formatDate = useDateFormat();
  const TypeIcon = lesson.group.type === "ONE_ON_ONE" ? User : Users;
  const reason = lesson.cancelReason
    ? tr.has(lesson.cancelReason as "HOLIDAY")
      ? tr(lesson.cancelReason as "HOLIDAY")
      : lesson.cancelReason
    : null;

  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Link
          href={back.href}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          {back.label}
        </Link>
        <div className="flex gap-2">
          <NavButton
            href={previousHref}
            label={t("prevOfGroup", { group: lesson.group.name })}
          >
            <ChevronLeft aria-hidden="true" />
          </NavButton>
          <NavButton
            href={nextHref}
            label={t("nextOfGroup", { group: lesson.group.name })}
          >
            <ChevronRight aria-hidden="true" />
          </NavButton>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{lesson.group.name}</h1>
        {lesson.badge === "noLog" && (
          <Badge className="border-warning-border bg-warning-surface text-warning">
            <NotebookPen aria-hidden="true" />
            {t("status.noLog")}
          </Badge>
        )}
        {lesson.badge === "cancelled" && (
          <Badge variant="destructive">
            <Ban aria-hidden="true" />
            {t("status.cancelled")}
          </Badge>
        )}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground tabular-nums">
        <span>{formatDate(lesson.date, "weekdayDate")}</span>
        <span aria-hidden="true">·</span>
        <span>
          {formatMinutes(lesson.startMinute)}–{formatMinutes(lesson.endMinute)}
        </span>
        <span aria-hidden="true">·</span>
        <span>{lesson.room?.name ?? tt("details.noRoom")}</span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1">
          <TypeIcon aria-hidden="true" className="size-4" />
          {lesson.group.type === "ONE_ON_ONE"
            ? tt("type.oneOnOne")
            : tt("type.group")}
        </span>
        <span aria-hidden="true">·</span>
        <span>{lesson.level}</span>
      </p>
      {lesson.room?.online && lesson.room.meetingUrl && (
        <a
          href={lesson.room.meetingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({
            variant: "outline",
            className: "self-start",
          })}
        >
          <ExternalLink aria-hidden="true" />
          {tt("details.joinOnline")}
          <span className="sr-only">{tc("opensInNewTab")}</span>
        </a>
      )}
      {lesson.badge === "cancelled" && (
        <Alert className="border-danger-border bg-danger-surface text-danger">
          <Ban aria-hidden="true" />
          <AlertDescription className="text-danger">
            {reason ? t("cancelledBanner", { reason }) : t("cancelledNoReason")}
          </AlertDescription>
        </Alert>
      )}
      {banners}
    </header>
  );
}

/** Substitute banner (`info`, §5.2). */
export function SubstituteBanner({ text }: { text: string }) {
  return (
    <Alert className="border-info-border bg-info-surface text-info">
      <UserRoundCog aria-hidden="true" />
      <AlertDescription className="text-info">{text}</AlertDescription>
    </Alert>
  );
}
