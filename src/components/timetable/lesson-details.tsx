"use client";

import {
  CalendarX,
  ClipboardList,
  ExternalLink,
  NotebookPen,
  Repeat,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useState } from "react";

import { CancelBookingDialog } from "@/components/absences/cancel-booking-dialog";
import { CancelLessonDialog } from "@/components/absences/cancel-lesson-dialog";
import { RescheduleSheet } from "@/components/absences/reschedule-sheet";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { isNotAttending } from "./lesson-parts";

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
  const tl = useTranslations("lessons");
  const tb = useTranslations("bookings");
  const formatDate = useDateFormat();
  const mobile = useIsMobile();
  // "View lesson" only once the lesson has started (lessons.md §2); the
  // lesson page itself enforces the same rule server-side.
  const now = useNow({ updateInterval: 60_000 });
  const started =
    lesson !== null && new Date(lesson.startsAt).getTime() <= now.getTime();
  const [cancelling, setCancelling] = useState(false);
  const notAttending = lesson !== null && isNotAttending(lesson);
  const attendance = role === "STUDENT" ? lesson?.attendance : null;
  const canCancel =
    lesson !== null &&
    attendance != null &&
    !attendance.cancelled &&
    lesson.status === "SCHEDULED" &&
    !started;

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
                {notAttending && attendance?.cancelled ? (
                  <NotAttending cancelled={attendance.cancelled} />
                ) : (
                  <Badge
                    variant={
                      lesson.status === "CANCELLED"
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {lesson.status === "CANCELLED"
                      ? t("status.cancelled")
                      : lesson.status === "COMPLETED"
                        ? t("status.completed")
                        : t("status.scheduled")}
                  </Badge>
                )}
                {!notAttending &&
                  lesson.status === "CANCELLED" &&
                  lesson.cancelReason && (
                    <span>
                      {t("details.cancelReason", {
                        reason: tr.has(lesson.cancelReason as "HOLIDAY")
                          ? tr(lesson.cancelReason as "HOLIDAY")
                          : lesson.cancelReason,
                      })}
                    </span>
                  )}
              </dd>
              {attendance?.booking && lesson.status !== "CANCELLED" && (
                <>
                  <dt className="text-muted-foreground">{tb("row")}</dt>
                  <dd className="flex items-start gap-2">
                    <Repeat
                      aria-hidden="true"
                      className="mt-1 size-4 shrink-0 text-lesson-replacement"
                    />
                    {attendance.booking.kind === "replacement"
                      ? tb("rowText", {
                          date: formatDate(
                            attendance.booking.originalDate,
                            "weekdayLong",
                          ),
                        })
                      : tb("rowTextRescheduled", {
                          date: formatDate(
                            attendance.booking.originalDate,
                            "weekdayLong",
                          ),
                        })}
                  </dd>
                </>
              )}
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
              {role === "STUDENT" && lesson.homework && (
                <>
                  <dt className="text-muted-foreground">
                    {tl("sheet.homework")}
                  </dt>
                  <dd className="flex gap-2">
                    <ClipboardList
                      aria-hidden="true"
                      className="mt-1 size-4 shrink-0 text-primary"
                    />
                    <span className="break-words whitespace-pre-wrap">
                      {lesson.homework}
                    </span>
                  </dd>
                </>
              )}
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
            {role === "TEACHER" && (
              <div className="px-4 pb-4">
                <Link
                  href={`/teacher/lessons/${lesson.id}`}
                  className={buttonVariants({ size: "lg" })}
                >
                  <NotebookPen aria-hidden="true" />
                  {tl("open")}
                </Link>
              </div>
            )}
            {canCancel && attendance && (
              <CantAttend
                lesson={lesson}
                open={cancelling}
                onOpenChange={setCancelling}
              />
            )}
            {role === "STUDENT" && started && (
              <div className="px-4 pb-4">
                <Link
                  href={`/student/lessons/${lesson.id}?from=timetable`}
                  className={buttonVariants({ size: "lg" })}
                >
                  {tl("view")}
                </Link>
              </div>
            )}
            {role === "ADMIN" && (
              <div className="flex flex-wrap gap-2 px-4 pb-4">
                <Link
                  href={`/admin/lessons/${lesson.id}?from=timetable`}
                  className={buttonVariants({ size: "lg" })}
                >
                  <NotebookPen aria-hidden="true" />
                  {tl("open")}
                </Link>
                {lesson.slotId && (
                  <Link
                    href={`/admin/timetable/edit?term=${lesson.termId}&slot=${lesson.slotId}&asOf=${lesson.date}`}
                    className={buttonVariants({
                      variant: "outline",
                      size: "lg",
                    })}
                  >
                    {t("details.openInEditor")}
                  </Link>
                )}
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** "Not attending" badge and what the cancellation gave (absences.md §5.1). */
function NotAttending({
  cancelled,
}: {
  cancelled: { at: string; byOffice: boolean; credit: boolean };
}) {
  const t = useTranslations("absences");
  const format = useFormatter();
  const date = format.dateTime(new Date(cancelled.at), {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return (
    <>
      <Badge variant="secondary">
        <CalendarX aria-hidden="true" />
        {t("notAttending")}
      </Badge>
      <span>
        {cancelled.byOffice
          ? t("byOffice", { date })
          : t("youCancelled", { date })}
      </span>
      <span>{cancelled.credit ? t("gotCredit") : t("noCreditLate")}</span>
      <span className="text-muted-foreground">{t("changedMind")}</span>
    </>
  );
}

/**
 * "Can't attend?" with the cutoff caption (§5.1): the cancel dialog for a
 * group lesson, the Reschedule sheet for a 1-on-1 before its cutoff (§5.3),
 * and "Cancel booking" for a replacement (§5.7).
 */
function CantAttend({
  lesson,
  open,
  onOpenChange,
}: {
  lesson: LessonView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("absences");
  const tb = useTranslations("bookings");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const [rescheduling, setRescheduling] = useState(false);
  const attendance = lesson.attendance!;
  const booking = attendance.booking;
  const cutoff = new Date(attendance.cutoffAt);
  const dateTime = format.dateTime(cutoff, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const before = now.getTime() <= cutoff.getTime();
  const oneOnOne = lesson.group.type === "ONE_ON_ONE";
  if (booking?.kind === "replacement" && booking.bookingId) {
    return (
      <div className="flex flex-col items-start gap-2 px-4 pb-4">
        <Button variant="outline" size="lg" onClick={() => onOpenChange(true)}>
          <CalendarX aria-hidden="true" />
          {tb("cancelBooking")}
        </Button>
        <p className={before ? "text-sm text-info" : "text-sm text-warning"}>
          {before
            ? attendance.cutoffMinutes === 0
              ? t("cutoff.beforeZero")
              : t("cutoff.before", { dateTime })
            : t("cutoff.after", { dateTime })}
        </p>
        <CancelBookingDialog
          open={open}
          onOpenChange={onOpenChange}
          booking={{
            bookingId: booking.bookingId,
            groupName: lesson.group.name,
            date: lesson.date,
            startMinute: lesson.startMinute,
            endMinute: lesson.endMinute,
            startsAt: lesson.startsAt,
            cutoffAt: attendance.cutoffAt,
            credit: booking.credit,
          }}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2 px-4 pb-4">
      <Button
        variant="outline"
        size="lg"
        onClick={() =>
          oneOnOne && before ? setRescheduling(true) : onOpenChange(true)
        }
      >
        <CalendarX aria-hidden="true" />
        {t("cantAttend")}
      </Button>
      {oneOnOne && (
        <RescheduleSheet
          source={{ lessonId: lesson.id }}
          open={rescheduling}
          onOpenChange={setRescheduling}
          onCancelLater={() => onOpenChange(true)}
        />
      )}
      <p className={before ? "text-sm text-info" : "text-sm text-warning"}>
        {before
          ? attendance.cutoffMinutes === 0
            ? t("cutoff.beforeZero")
            : t("cutoff.before", { dateTime })
          : t("cutoff.after", { dateTime })}
      </p>
      <CancelLessonDialog
        open={open}
        onOpenChange={onOpenChange}
        lesson={{
          id: lesson.id,
          groupName: lesson.group.name,
          level: lesson.level,
          oneOnOne: lesson.group.type === "ONE_ON_ONE",
          teacherName: lesson.teacher.name,
          date: lesson.date,
          startMinute: lesson.startMinute,
          endMinute: lesson.endMinute,
          attendance,
        }}
      />
    </div>
  );
}
