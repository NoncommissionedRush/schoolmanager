import { AlertTriangle, Ban, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { ToneAlert } from "@/components/absences/tone";
import { StudentPageSkeleton } from "@/components/lessons/student-homework";
import { calendarDate } from "@/components/timetable/format";
import { buttonVariants } from "@/components/ui/button";
import { studentContext } from "@/server/lessons/student-context";
import { loadBookingPage } from "@/server/replacements/booking";
import { expireCredits } from "@/server/replacements/service";
import { addDays, toZonedDateTime } from "@/server/scheduling";
import { mondayOf, resolveWeek } from "@/server/timetable/week";

import { BookingList, CreditSwitch } from "./book-client";

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/**
 * Book a replacement (absences.md §5.5): the lessons the student can book
 * with one credit, a week at a time from this week until the credit's
 * expiry. The list is `checkReplacement` over the candidates; booking
 * re-checks everything on the server.
 */
async function BookReplacement({
  searchParams,
}: PageProps<"/student/absences/book">) {
  const { db, viewer } = await studentContext();
  const params = await searchParams;
  const now = new Date();
  await expireCredits(db, now);
  const page = await loadBookingPage(
    db,
    { userId: viewer.userId },
    first(params.credit) ?? "",
    now,
  );
  const t = await getTranslations("replacements.book");
  const format = await getFormatter();
  const date = (iso: string, weekday = true) =>
    format.dateTime(calendarDate(iso), {
      ...(weekday && { weekday: "short" }),
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const today = toZonedDateTime(now, viewer.school.timezone).date;
  const thisWeek = mondayOf(today);

  const back = (
    <Link
      href="/student/absences"
      className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      {t("back")}
    </Link>
  );

  if (page.state === "notFound") notFound();
  let body: React.ReactNode;
  if (page.state === "noLevel") {
    body = (
      <ToneAlert tone="warning" icon={AlertTriangle}>
        {t("noLevel")}
      </ToneAlert>
    );
  } else if (page.state !== "ok") {
    body = (
      <div className="flex flex-col gap-3">
        <ToneAlert tone="danger" icon={Ban}>
          {page.state === "expired"
            ? t("creditExpired", { date: date(page.validUntil) })
            : t("creditUsed")}
        </ToneAlert>
        <Link
          href="/student/absences"
          className={buttonVariants({ variant: "outline", size: "lg" })}
        >
          {t("backToAbsences")}
        </Link>
      </div>
    );
  } else {
    const lastWeek = mondayOf(page.credit.validUntil);
    let week = resolveWeek(first(params.week), today);
    if (week < thisWeek) week = thisWeek;
    if (week > lastWeek) week = lastWeek;
    const weekEnd = addDays(week, 6);
    const inWeek = page.lessons.filter(
      (l) => l.date >= week && l.date <= weekEnd,
    );
    const href = (w: string) =>
      `/student/absences/book?credit=${page.credit.id}&week=${w}`;
    body = (
      <>
        <p className="text-muted-foreground">
          {t("usingCredit", {
            sourceDate: date(page.credit.sourceDate),
            expiry: date(page.credit.validUntil, false),
          })}
        </p>
        {page.otherCredits.length > 0 && (
          <CreditSwitch current={page.credit} others={page.otherCredits} />
        )}
        <section aria-labelledby="lessons" className="flex flex-col gap-3">
          <h2 id="lessons" className="text-lg font-semibold">
            {t("listTitle", { level: page.level })}
          </h2>
          {page.lessons.length === 0 ? (
            <p className="text-muted-foreground">
              {t("emptyAll", {
                level: page.level,
                date: date(page.credit.validUntil),
              })}
            </p>
          ) : (
            <>
              <nav className="flex items-center justify-between gap-2">
                {week > thisWeek ? (
                  <Link
                    href={href(addDays(week, -7))}
                    aria-label={t("previousWeek")}
                    className={buttonVariants({
                      variant: "outline",
                      size: "icon-lg",
                    })}
                  >
                    <ChevronLeft aria-hidden="true" />
                  </Link>
                ) : (
                  <span className="size-9" />
                )}
                <span className="font-medium tabular-nums">
                  {t("weekLabel", {
                    from: date(week, false),
                    to: date(weekEnd, false),
                  })}
                </span>
                {week < lastWeek ? (
                  <Link
                    href={href(addDays(week, 7))}
                    aria-label={t("nextWeek")}
                    className={buttonVariants({
                      variant: "outline",
                      size: "icon-lg",
                    })}
                  >
                    <ChevronRight aria-hidden="true" />
                  </Link>
                ) : (
                  <span className="size-9" />
                )}
              </nav>
              {inWeek.length === 0 ? (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-muted-foreground">
                    {t("emptyWeek", { level: page.level })}
                  </p>
                  {week < lastWeek && (
                    <Link
                      href={href(addDays(week, 7))}
                      className={buttonVariants({
                        variant: "outline",
                        size: "lg",
                      })}
                    >
                      {t("nextWeek")}
                    </Link>
                  )}
                </div>
              ) : (
                <BookingList credit={page.credit} lessons={inWeek} />
              )}
            </>
          )}
          <p className="text-sm text-muted-foreground">{t("clashHint")}</p>
        </section>
      </>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 text-base">
      <header className="flex flex-col gap-1">
        {back}
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
      </header>
      {body}
    </div>
  );
}

export default function Page(props: PageProps<"/student/absences/book">) {
  return (
    <Suspense fallback={<StudentPageSkeleton />}>
      <BookReplacement {...props} />
    </Suspense>
  );
}
