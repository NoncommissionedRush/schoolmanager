import { CalendarX, Repeat, Ticket } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { ToneBadge } from "@/components/absences/tone";
import { EmptyState } from "@/components/empty-state";
import { StudentPageSkeleton } from "@/components/lessons/student-homework";
import { calendarDate, formatMinutes } from "@/components/timetable/format";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { studentContext } from "@/server/lessons/student-context";
import { parseShown } from "@/server/lessons/student-rules";
import { expireCredits } from "@/server/replacements/service";
import {
  HISTORY_PAGE,
  loadStudentAbsences,
  type StudentCredit,
  type StudentHistoryItem,
} from "@/server/replacements/views";

import { BookingActions, RescheduleCreditButton } from "./absences-client";

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/** Credits expiring within this many days get the warning badge (§3.2). */
const EXPIRING_SOON_DAYS = 7;

/**
 * Student Absences tab (absences.md §5.4): available makeup credits,
 * upcoming bookings and cancellations, and history. Only the student's own
 * rows.
 */
async function StudentAbsences({
  searchParams,
}: PageProps<"/student/absences">) {
  const { db, scope, viewer } = await studentContext();
  const now = new Date();
  const shown = parseShown(first((await searchParams).shown));
  await expireCredits(db, now);
  const data = scope.studentId
    ? await loadStudentAbsences(
        db,
        { id: scope.studentId, userId: viewer.userId },
        { shownHistory: shown },
        now,
      )
    : null;
  const t = await getTranslations("absences");
  const tc = await getTranslations("credits");
  const tb = await getTranslations("bookings");
  const tr = await getTranslations("replacements");
  const ts = await getTranslations("reschedule");
  const format = await getFormatter();
  const date = (iso: string, weekday = true) =>
    format.dateTime(calendarDate(iso), {
      ...(weekday && { weekday: "short" }),
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });

  const empty =
    !data ||
    (data.credits.length === 0 &&
      data.bookings.length === 0 &&
      data.upcoming.length === 0 &&
      data.historyCount === 0);
  const historyText = (item: StudentHistoryItem) => {
    switch (item.kind) {
      case "cancelledNoCredit":
        return t("history.cancelledNoCredit", {
          date: date(item.sourceDate),
          group: item.groupName,
        });
      case "removedBySchool":
        return item.lessonCancelled || !item.reason
          ? t("history.removedLessonCancelled", {
              date: date(item.sourceDate),
              group: item.groupName,
            })
          : t("history.removedBySchool", {
              date: date(item.sourceDate),
              group: item.groupName,
              reason: item.reason,
            });
      case "creditUsed":
        return item.usedFor?.kind === "replacement"
          ? t("history.creditUsedFor", {
              sourceDate: date(item.sourceDate),
              group: item.usedFor.groupName,
              date: date(item.usedFor.date),
            })
          : item.usedFor
            ? t("history.creditRescheduledTo", {
                sourceDate: date(item.sourceDate),
                date: date(item.usedFor.date),
                time: formatMinutes(item.usedFor.startMinute),
              })
            : t("history.creditUsed", { sourceDate: date(item.sourceDate) });
      default:
        return t("history.creditExpired", {
          sourceDate: date(item.sourceDate),
          date: date(item.expiredOn),
        });
    }
  };

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 text-base">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        {data && (
          <p className="text-sm text-muted-foreground">
            {data.policy.hours === 0
              ? t("policyZero", { days: data.policy.days })
              : t("policy", data.policy)}
          </p>
        )}
      </header>
      {empty ? (
        <EmptyState
          icon={CalendarX}
          title={t("empty.title")}
          description={t("empty.description")}
        />
      ) : (
        <>
          <section aria-labelledby="credits" className="flex flex-col gap-3">
            <h2 id="credits" className="text-lg font-semibold">
              {t("section.credits", { count: data.credits.length })}
            </h2>
            {data.credits.length === 0 ? (
              <p className="text-muted-foreground">{tc("none")}</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {data.credits.map((credit) => (
                  <li key={credit.id}>
                    <CreditCard credit={credit} date={date} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          {data.bookings.length > 0 && (
            <section aria-labelledby="bookings" className="flex flex-col gap-3">
              <h2 id="bookings" className="text-lg font-semibold">
                {tb("section", { count: data.bookings.length })}
              </h2>
              <ul className="flex flex-col gap-3">
                {data.bookings.map((booking) => (
                  <li key={booking.lessonId}>
                    <Card className="border-l-4 border-l-lesson-replacement bg-lesson-replacement-surface">
                      <CardContent className="flex flex-col gap-2">
                        <p className="flex flex-wrap items-center gap-x-2 font-medium tabular-nums">
                          <Repeat
                            aria-hidden="true"
                            className="size-4 text-lesson-replacement"
                          />
                          <span>{date(booking.date)}</span>
                          <span>
                            {formatMinutes(booking.startMinute)}–
                            {formatMinutes(booking.endMinute)}
                          </span>
                        </p>
                        <p className="text-sm">
                          {booking.oneOnOne
                            ? t("oneOnOneWith", {
                                teacher: booking.teacherName,
                              })
                            : booking.groupName}{" "}
                          ·{" "}
                          {booking.kind === "replacement"
                            ? tr("badge")
                            : ts("badge")}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {tr("forYourLesson", {
                            date: date(booking.originalDate),
                          })}
                        </p>
                        {booking.changedBySchool !== null && (
                          <p className="text-sm">
                            <ToneBadge tone="info">
                              {tr("changedBySchool")}
                            </ToneBadge>{" "}
                            {booking.changedBySchool}
                          </p>
                        )}
                        <BookingActions
                          booking={booking}
                          cutoffMinutes={data.policy.cutoffMinutes}
                          nowIso={now.toISOString()}
                        />
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.upcoming.length > 0 && (
            <section
              aria-labelledby="cancellations"
              className="flex flex-col gap-3"
            >
              <h2 id="cancellations" className="text-lg font-semibold">
                {t("section.cancellations", { count: data.upcoming.length })}
              </h2>
              <ul className="flex flex-col gap-3">
                {data.upcoming.map((item) => (
                  <li key={item.id}>
                    <Card className="border-l-4 border-l-lesson-cancelled">
                      <CardContent className="flex flex-col gap-1">
                        <p className="flex flex-wrap gap-x-2 font-medium tabular-nums">
                          <span>{date(item.date)}</span>
                          <span>
                            {formatMinutes(item.startMinute)}–
                            {formatMinutes(item.endMinute)}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {item.oneOnOne
                              ? t("oneOnOneWith", { teacher: item.teacherName })
                              : item.groupName}
                          </span>
                        </p>
                        <p className="flex flex-wrap items-center gap-2 text-sm">
                          <ToneBadge
                            tone={item.credit ? "success" : "muted"}
                            icon={item.credit ? Ticket : undefined}
                          >
                            {item.credit
                              ? t("status.creditEarned")
                              : t("status.noCredit")}
                          </ToneBadge>
                          {item.byOffice && (
                            <span className="text-muted-foreground">
                              {t("status.byOffice")}
                            </span>
                          )}
                        </p>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
              <p className="text-sm text-muted-foreground">
                {t("changedMind")}
              </p>
            </section>
          )}
          {data.historyCount > 0 && (
            <details
              open={shown > HISTORY_PAGE}
              className="group flex flex-col gap-3"
            >
              <summary className="min-h-11 cursor-pointer text-lg font-semibold">
                {t("section.history", { count: data.historyCount })}
              </summary>
              <ul className="mt-3 flex flex-col gap-2 text-sm">
                {data.history.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-b pb-2"
                  >
                    <span>{historyText(item)}</span>
                    {item.kind === "removedBySchool" ? (
                      <ToneBadge tone="danger">
                        {tr("removedBySchool")}
                      </ToneBadge>
                    ) : (
                      item.kind !== "cancelledNoCredit" && (
                        <ToneBadge tone="muted">
                          {item.kind === "creditUsed"
                            ? tc("used")
                            : tc("expired")}
                        </ToneBadge>
                      )
                    )}
                  </li>
                ))}
              </ul>
              {data.history.length < data.historyCount && (
                <Link
                  href={`/student/absences?shown=${shown + HISTORY_PAGE}`}
                  scroll={false}
                  className={buttonVariants({
                    variant: "outline",
                    size: "lg",
                    className: "mt-3 self-start",
                  })}
                >
                  {t("history.loadMore")}
                </Link>
              )}
            </details>
          )}
        </>
      )}
    </div>
  );
}

async function CreditCard({
  credit,
  date,
}: {
  credit: StudentCredit;
  date: (iso: string, weekday?: boolean) => string;
}) {
  const t = await getTranslations("absences");
  const tc = await getTranslations("credits");
  const soon = credit.daysLeft <= EXPIRING_SOON_DAYS;
  return (
    <Card className="border-l-4 border-l-success">
      <CardContent className="flex flex-col gap-2">
        <p className="flex items-center gap-2 font-medium">
          <Ticket aria-hidden="true" className="size-4 text-success" />
          {tc("from", { date: date(credit.sourceDate) })}
        </p>
        <p className="text-sm">
          {credit.oneOnOne
            ? t("oneOnOneWith", { teacher: credit.teacherName })
            : credit.groupName}
        </p>
        <span>
          <ToneBadge tone={soon ? "warning" : "success"} icon={Ticket}>
            {soon
              ? tc("expiresIn", { days: credit.daysLeft })
              : tc("validUntil", { date: date(credit.validUntil, false) })}
          </ToneBadge>
        </span>
        {credit.oneOnOne ? (
          <RescheduleCreditButton creditId={credit.id} />
        ) : (
          <Link
            href={`/student/absences/book?credit=${credit.id}`}
            className={buttonVariants({ size: "lg", className: "w-full" })}
          >
            {tc("book")}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

export default function Page(props: PageProps<"/student/absences">) {
  return (
    <Suspense fallback={<StudentPageSkeleton />}>
      <StudentAbsences {...props} />
    </Suspense>
  );
}
