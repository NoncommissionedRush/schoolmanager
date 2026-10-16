import { BookOpen, Ticket } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { DashboardHeader } from "@/components/dashboard-header";
import { EmptyState } from "@/components/empty-state";
import { LatestHomeworkCard } from "@/components/lessons/latest-homework-card";
import { calendarDate } from "@/components/timetable/format";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { loadLatestHomework } from "@/server/lessons/student";
import { studentContext } from "@/server/lessons/student-context";
import { loadStudentRatings } from "@/server/ratings/student";
import { loadStudentCreditSummary } from "@/server/replacements/views";
import { RateTeacherCard } from "@/components/ratings/rate-teacher-card";

export default async function StudentHomePage() {
  const { viewer, db, scope } = await studentContext();
  const t = await getTranslations("dashboard.student");
  const now = new Date();
  const [latest, credits, ratings] = await Promise.all([
    loadLatestHomework(db, scope, now, viewer.school.timezone),
    scope.studentId
      ? loadStudentCreditSummary(db, scope.studentId, now)
      : { count: 0, soonest: null },
    loadStudentRatings(db, viewer.userId, now, viewer.school.timezone),
  ]);
  // The first teacher the student can rate and hasn't (design §6.3).
  const toRate = ratings.current
    .flatMap((term) => term.cards.map((card) => ({ term: term.term.id, card })))
    .find(({ card }) => card.state === "open");
  // Single column at every width (mobile-first, §7.4).
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 md:gap-6">
      <DashboardHeader viewer={viewer} variant="student" />
      {scope.memberships.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={t("empty.title")}
          description={t("empty.description")}
        />
      ) : (
        <>
          {toRate && (
            <RateTeacherCard
              teacher={toRate.card.teacherName}
              href={`/student/ratings/${toRate.card.teacherId}?term=${toRate.term}`}
            />
          )}
          {credits.count > 0 && <CreditsCard {...credits} />}
          <LatestHomeworkCard items={latest} />
        </>
      )}
    </div>
  );
}

/** "You have N makeup credits" (absences.md §5.4), hidden at 0. */
async function CreditsCard({
  count,
  soonest,
}: {
  count: number;
  soonest: string | null;
}) {
  const t = await getTranslations("credits.home");
  const format = await getFormatter();
  return (
    <Card className="border-l-4 border-l-success">
      <CardContent className="flex flex-col items-start gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Ticket aria-hidden="true" className="size-5 text-success" />
          {t("title", { count })}
        </h2>
        {soonest && (
          <p className="text-sm text-muted-foreground">
            {t("soonest", {
              date: format.dateTime(calendarDate(soonest), {
                weekday: "short",
                day: "numeric",
                month: "short",
                timeZone: "UTC",
              }),
            })}
          </p>
        )}
        <Link
          href="/student/absences"
          className={buttonVariants({ variant: "outline", size: "lg" })}
        >
          {t("use")}
        </Link>
      </CardContent>
    </Card>
  );
}
