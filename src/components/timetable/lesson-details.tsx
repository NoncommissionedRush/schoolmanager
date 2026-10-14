"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import type { LessonView, ViewerKind } from "@/server/timetable/week";

import { formatMinutes, useDateFormat } from "./format";

/** Lesson details sheet (timetable.md §6.3): right on desktop, bottom on mobile. */
export function LessonDetailsSheet({
  lesson,
  role,
  onOpenChange,
}: {
  lesson: LessonView | null;
  role: ViewerKind;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("timetable");
  const tc = useTranslations("common");
  const tr = useTranslations("scheduling.cancelReasons");
  const formatDate = useDateFormat();
  const mobile = useIsMobile();

  return (
    <Sheet open={lesson !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side={mobile ? "bottom" : "right"}
        closeLabel={tc("close")}
        className={mobile ? "max-h-[85svh] rounded-t-xl" : "sm:max-w-md"}
      >
        {lesson && (
          <>
            <SheetHeader>
              <SheetTitle>{lesson.group.name}</SheetTitle>
              <SheetDescription>
                {lesson.group.type === "ONE_ON_ONE"
                  ? t("type.oneOnOne")
                  : t("type.group")}
              </SheetDescription>
            </SheetHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 overflow-y-auto px-4 pb-6">
              <dt className="text-muted-foreground">{t("details.status")}</dt>
              <dd className="flex flex-col items-start gap-1">
                <Badge
                  variant={
                    lesson.status === "CANCELLED" ? "destructive" : "secondary"
                  }
                >
                  {lesson.status === "CANCELLED"
                    ? t("status.cancelled")
                    : lesson.status === "COMPLETED"
                      ? t("status.completed")
                      : t("status.scheduled")}
                </Badge>
                {lesson.status === "CANCELLED" && lesson.cancelReason && (
                  <span>
                    {t("details.cancelReason", {
                      reason: tr.has(lesson.cancelReason as "HOLIDAY")
                        ? tr(lesson.cancelReason as "HOLIDAY")
                        : lesson.cancelReason,
                    })}
                  </span>
                )}
              </dd>
              <dt className="text-muted-foreground">{t("details.when")}</dt>
              <dd>
                {t("details.whenValue", {
                  date: formatDate(lesson.date, "long"),
                  time: `${formatMinutes(lesson.startMinute)}–${formatMinutes(lesson.endMinute)}`,
                  minutes: lesson.endMinute - lesson.startMinute,
                })}
              </dd>
              <dt className="text-muted-foreground">
                {t("details.typeLevel")}
              </dt>
              <dd>
                {t("details.typeLevelValue", {
                  type:
                    lesson.group.type === "ONE_ON_ONE"
                      ? t("type.oneOnOne")
                      : t("type.group"),
                  level: lesson.level,
                })}
              </dd>
              <dt className="text-muted-foreground">{t("details.teacher")}</dt>
              <dd>
                {lesson.substitute
                  ? t("substitute.detail", {
                      substitute: lesson.substitute.name,
                      teacher: lesson.teacher.name,
                    })
                  : lesson.teacher.name}
              </dd>
              <dt className="text-muted-foreground">{t("details.room")}</dt>
              <dd className="flex flex-col items-start gap-2">
                {lesson.room?.name ?? t("details.noRoom")}
                {lesson.room?.online && lesson.room.meetingUrl && (
                  <a
                    href={lesson.room.meetingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ size: "lg" })}
                  >
                    <ExternalLink aria-hidden="true" />
                    {t("details.joinOnline")}
                    <span className="sr-only">{tc("opensInNewTab")}</span>
                  </a>
                )}
              </dd>
              {lesson.students && role !== "STUDENT" && (
                <>
                  <dt className="text-muted-foreground">
                    {t("details.students", { count: lesson.students.length })}
                  </dt>
                  <dd>
                    <ul className="flex flex-col gap-0.5">
                      {lesson.students.map((s) => (
                        <li key={s.id}>{s.name}</li>
                      ))}
                    </ul>
                  </dd>
                </>
              )}
            </dl>
            {role === "ADMIN" && lesson.slotId && (
              <div className="px-4 pb-4">
                <Link
                  href={`/admin/timetable/edit?term=${lesson.termId}&slot=${lesson.slotId}&asOf=${lesson.date}`}
                  className={buttonVariants({ variant: "outline" })}
                >
                  {t("details.openInEditor")}
                </Link>
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
