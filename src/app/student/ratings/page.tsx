import { ChevronRight, Lock, Star } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { ToneAlert } from "@/components/absences/tone";
import { EmptyState } from "@/components/empty-state";
import { StudentPageSkeleton } from "@/components/lessons/student-homework";
import { Stars } from "@/components/ratings/stars";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getSchoolFormatter } from "@/i18n/school-format";
import { db } from "@/lib/db";
import { requireRole } from "@/server/auth/session";
import { scopeToSchool } from "@/server/db/school-scope";
import {
  loadStudentRatings,
  type RatingCard,
  type RatingTermCards,
} from "@/server/ratings/student";

/** _Rate your teachers_ (notifications-substitutes.md §6.3). */
async function StudentRatings() {
  const viewer = await requireRole("STUDENT");
  const data = await loadStudentRatings(
    scopeToSchool(db, viewer.school.id),
    viewer.userId,
    new Date(),
    viewer.school.timezone,
  );
  const t = await getTranslations("ratings.student");
  const format = await getSchoolFormatter(viewer.school);
  const date = (d: Date) => format.dateTime(d, "dayMonth");

  const card = (term: RatingTermCards, c: RatingCard) => {
    const name = c.substitute
      ? t("substitute", { name: c.teacherName })
      : c.teacherName;
    const href = `/student/ratings/${c.teacherId}?term=${term.term.id}`;
    return (
      <li key={`${term.term.id}:${c.teacherId}`}>
        <Card className="py-4">
          <CardContent className="flex flex-col gap-1">
            <span className="font-medium">{name}</span>
            {c.groups.length > 0 && (
              <span className="text-sm text-muted-foreground">
                {c.groups.join(", ")}
              </span>
            )}
            {c.state === "opensLater" ? (
              <span className="text-sm">
                {t("opensOn", {
                  teacher: c.teacherName,
                  date: date(c.opensAt),
                })}
              </span>
            ) : c.rating ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-col gap-1 text-sm">
                  <span className="flex items-center gap-2">
                    <Stars
                      score={c.rating.score}
                      label={t("stars", { score: c.rating.score })}
                    />
                    {t("ratedOn", { date: date(c.rating.createdAt) })}
                  </span>
                  {c.state === "rated" && (
                    <span className="text-muted-foreground">
                      {t("editableUntil", { date: date(c.editableUntil) })}
                    </span>
                  )}
                </span>
                <Link
                  href={href}
                  aria-label={
                    c.state === "rated"
                      ? t("editTeacher", { teacher: c.teacherName })
                      : undefined
                  }
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {c.state === "rated" ? t("edit") : t("view")}
                  <ChevronRight aria-hidden="true" />
                </Link>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">
                  {t("notRated")}
                </span>
                <Link
                  href={href}
                  aria-label={t("rateTeacher", { teacher: c.teacherName })}
                  className={buttonVariants({ size: "sm" })}
                >
                  {t("rate")}
                  <ChevronRight aria-hidden="true" />
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      </li>
    );
  };

  const empty = data.current.length === 0 && data.earlier.length === 0;
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 text-base">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <ToneAlert tone="info" icon={Lock}>
        {t("privacy")}
      </ToneAlert>
      {empty ? (
        <EmptyState
          icon={Star}
          title={t("empty.title")}
          description={t("empty.description")}
        />
      ) : (
        <>
          {data.current.map((term) => (
            <section
              key={term.term.id}
              aria-labelledby={`term-${term.term.id}`}
              className="flex flex-col gap-2"
            >
              <h2
                id={`term-${term.term.id}`}
                className="text-sm font-medium text-muted-foreground"
              >
                {term.term.name}
              </h2>
              <ul className="flex flex-col gap-3">
                {term.cards.map((c) => card(term, c))}
              </ul>
            </section>
          ))}
          {data.earlier.length > 0 && (
            <details className="flex flex-col gap-2">
              <summary className="cursor-pointer font-medium">
                {t("earlierTerms")}
              </summary>
              {data.earlier.map((term) => (
                <section
                  key={term.term.id}
                  className="mt-2 flex flex-col gap-2"
                >
                  <h2 className="text-sm font-medium text-muted-foreground">
                    {term.term.name}
                  </h2>
                  <ul className="flex flex-col gap-3">
                    {term.cards.map((c) => card(term, c))}
                  </ul>
                </section>
              ))}
            </details>
          )}
        </>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<StudentPageSkeleton />}>
      <StudentRatings />
    </Suspense>
  );
}
