"use client";

import {
  CalendarX,
  EllipsisVertical,
  Repeat,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useNow, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LessonRosterView } from "@/server/replacements/views";

import { ToneAlert, ToneBadge } from "./tone";

/**
 * Students card on the teacher and admin lesson pages (absences.md §6.1):
 * who is coming, who cancelled (when, why, late, via office) and the seats
 * taken in the lesson's room. Read-only for teachers; admins get "Report
 * absence…" on coming members.
 */
export function StudentsCard({
  roster,
  onReport,
}: {
  roster: LessonRosterView;
  /** Admin lesson page only. */
  onReport?: (student: { id: string; name: string }) => void;
}) {
  const t = useTranslations("lessonStudents");
  const ts = useTranslations("reschedule");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  if (roster.schoolCancelled) return null;
  const rescheduled = roster.rescheduledFrom && (
    <ToneAlert tone="info" icon={Repeat}>
      {roster.rescheduledFrom.byAdmin
        ? ts("adminBanner", {
            dateTime: format.dateTime(
              new Date(roster.rescheduledFrom.startsAt),
              {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              },
            ),
          })
        : ts("teacherBanner", {
            student: roster.rescheduledFrom.name,
            dateTime: format.dateTime(
              new Date(roster.rescheduledFrom.startsAt),
              {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              },
            ),
          })}
    </ToneAlert>
  );
  if (roster.oneOnOneCancelled) {
    const { name, reason } = roster.oneOnOneCancelled;
    return (
      <ToneAlert tone="muted" icon={CalendarX}>
        {reason
          ? t("oneOnOneCancelledReason", { student: name, reason })
          : t("oneOnOneCancelled", { student: name })}
      </ToneAlert>
    );
  }

  const capacity = roster.room?.capacity ?? null;
  const over = capacity !== null && roster.seatsTaken > capacity;
  return (
    <>
      {rescheduled}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2">
          <CardTitle>
            <h2 className="text-lg font-semibold">{t("title")}</h2>
          </CardTitle>
          {roster.room && capacity !== null && (
            <p
              className={
                over
                  ? "flex items-center gap-1 text-sm text-warning tabular-nums"
                  : "text-sm text-muted-foreground tabular-nums"
              }
            >
              {over && <TriangleAlert aria-hidden="true" className="size-4" />}
              {over
                ? t("overCapacity", { taken: roster.seatsTaken, capacity })
                : t("seats", {
                    room: roster.room.name,
                    taken: roster.seatsTaken,
                    capacity,
                  })}
            </p>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <section aria-labelledby={`coming-${roster.lessonId}`}>
            <h3
              id={`coming-${roster.lessonId}`}
              className="mb-1 text-sm font-medium"
            >
              {t("coming", { count: roster.coming.length })}
            </h3>
            {roster.coming.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noStudents")}</p>
            ) : (
              <ul className="flex flex-col">
                {roster.coming.map((student) => (
                  <li
                    key={student.id}
                    className="flex min-h-9 flex-wrap items-center gap-2 text-sm"
                  >
                    <span>{student.name}</span>
                    {student.replacementFrom && (
                      <ToneBadge tone="warning" icon={Repeat}>
                        {t("replacementFrom", {
                          group: student.replacementFrom,
                        })}
                      </ToneBadge>
                    )}
                    {student.replacementFrom && onReport && (
                      <Link
                        href={`/admin/absences?tab=replacements&student=${student.id}`}
                        className="ml-auto text-sm underline-offset-4 hover:underline"
                      >
                        {t("review")}
                      </Link>
                    )}
                    {onReport &&
                      roster.reportable &&
                      !student.replacementFrom && (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="ml-auto"
                                aria-label={t("actionsFor", {
                                  name: student.name,
                                })}
                              />
                            }
                          >
                            <EllipsisVertical aria-hidden="true" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => onReport(student)}>
                              <CalendarX aria-hidden="true" />
                              {t("reportAbsence")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {roster.notComing.length === 0 ? (
            roster.coming.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {t("everyoneComing")}
              </p>
            )
          ) : (
            <section aria-labelledby={`not-coming-${roster.lessonId}`}>
              <h3
                id={`not-coming-${roster.lessonId}`}
                className="mb-1 text-sm font-medium"
              >
                {t("notComing", { count: roster.notComing.length })}
              </h3>
              <ul className="flex flex-col gap-1">
                {roster.notComing.map((student) => {
                  const at = new Date(student.reportedAt);
                  return (
                    <li
                      key={student.id}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
                    >
                      <span>{student.name}</span>
                      {student.replacement && (
                        <ToneBadge tone="warning" icon={Repeat}>
                          {t("replacement")}
                        </ToneBadge>
                      )}
                      <span className="text-muted-foreground">
                        <time
                          dateTime={student.reportedAt}
                          title={format.dateTime(at, {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        >
                          {t("cancelledAt", {
                            when: format.relativeTime(at, now),
                          })}
                        </time>
                      </span>
                      {student.reason && (
                        <span className="break-words text-muted-foreground">
                          &ldquo;{student.reason}&rdquo;
                        </span>
                      )}
                      {student.late && (
                        <ToneBadge tone="warning">{t("late")}</ToneBadge>
                      )}
                      {student.viaOffice && (
                        <span className="text-muted-foreground">
                          {t("viaOffice")}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </CardContent>
      </Card>
    </>
  );
}
