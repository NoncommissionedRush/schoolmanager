import { CalendarX, Ticket } from "lucide-react";
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
} from "@/server/replacements/views";

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/** Credits expiring within this many days get the warning badge (§3.2). */
const EXPIRING_SOON_DAYS = 7;

/**
 * Student Absences tab (absences.md §5.4): available makeup credits,
 * upcoming cancellations and history. Only the student's own rows.
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
      data.upcoming.length === 0 &&
      data.historyCount === 0);

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
            {data.credits.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {tc("comingSoon")}
              </p>
            )}
          </section>
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
                    <span>
                      {item.kind === "cancelledNoCredit"
                        ? t("history.cancelledNoCredit", {
                            date: date(item.sourceDate),
                            group: item.groupName,
                          })
                        : item.kind === "creditUsed"
                          ? t("history.creditUsed", {
                              sourceDate: date(item.sourceDate),
                            })
                          : t("history.creditExpired", {
                              sourceDate: date(item.sourceDate),
                              date: date(item.expiredOn),
                            })}
                    </span>
                    {item.kind !== "cancelledNoCredit" && (
                      <ToneBadge tone="muted">
                        {item.kind === "creditUsed"
                          ? tc("used")
                          : tc("expired")}
                      </ToneBadge>
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
