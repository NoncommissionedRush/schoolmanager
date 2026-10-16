import { Lock } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { ToneAlert } from "@/components/absences/tone";
import { ListFilters } from "@/components/admin/list-filters";
import { ArchivedBadge, PageHeader } from "@/components/admin/list";
import { TableSkeleton } from "@/components/admin/table-skeleton";
import { AverageText, Distribution } from "@/components/ratings/distribution";
import { Stars } from "@/components/ratings/stars";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getSchoolFormatter } from "@/i18n/school-format";
import { adminContext } from "@/server/admin/context";
import { param } from "@/server/admin/list";
import { type AdminRating, adminTeacherRatings } from "@/server/ratings/admin";
import { RATINGS_PAGE } from "@/server/ratings/admin-data";

import { HideRatingButton } from "./rating-actions";

/** One teacher's ratings (notifications-substitutes.md §6.5). Admins only. */
async function TeacherRatingsPage({
  params,
  searchParams,
}: PageProps<"/admin/ratings/[teacherId]">) {
  const { viewer } = await adminContext();
  const { teacherId } = await params;
  const query = await searchParams;
  const shownParam = param(query, "shown");
  const data = await adminTeacherRatings(teacherId, {
    term: param(query, "term") || undefined,
    group: param(query, "group") || undefined,
    shown: shownParam || undefined,
  });
  if (!data) notFound();
  const t = await getTranslations("ratings.admin");
  const ts = await getTranslations("ratings");
  const format = await getSchoolFormatter(viewer.school);
  const date = (d: Date) => format.dateTime(d, "short");
  const shown = data.visible.length;

  const moreHref = () => {
    const next = new URLSearchParams();
    if (data.term) next.set("term", data.term.id);
    if (data.groupId) next.set("group", data.groupId);
    next.set("shown", String(shown + RATINGS_PAGE));
    return `/admin/ratings/${data.teacher.id}?${next}`;
  };

  const ratingBody = (r: AdminRating) => (
    <div className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <Stars
          score={r.score}
          label={ts("student.stars", { score: r.score })}
        />
        <span className="text-sm font-medium">
          {ts(`form.star.${r.score}` as "form.star.1")}
        </span>
        {r.edited && (
          <span className="text-xs text-muted-foreground">
            {t("detail.edited")}
          </span>
        )}
      </span>
      {r.comment && <p className="whitespace-pre-wrap">{r.comment}</p>}
      <span className="text-sm text-muted-foreground">
        {t("detail.by", {
          student: r.studentName,
          group: r.groups.join(", ") || t("detail.noGroup"),
          date: date(r.createdAt),
        })}
      </span>
    </div>
  );

  return (
    <div className="mx-auto flex max-w-screen-lg flex-col gap-6">
      <PageHeader
        back={{
          href: data.term
            ? `/admin/ratings?term=${data.term.id}`
            : "/admin/ratings",
          label: t("detail.back"),
        }}
        title={data.teacher.name}
        badges={data.teacher.archived && <ArchivedBadge />}
      />
      <ToneAlert tone="info" icon={Lock}>
        {t("adminsOnly")}
      </ToneAlert>
      {data.term && (
        <>
          <ListFilters
            status={false}
            selects={[
              {
                name: "term",
                label: t("term"),
                defaultValue: data.term.id,
                options: data.terms.map((term) => ({
                  value: term.id,
                  label: term.name,
                })),
              },
              ...(data.groups.length > 1
                ? [
                    {
                      name: "group",
                      label: t("detail.group"),
                      defaultValue: "",
                      options: [
                        { value: "", label: t("detail.allGroups") },
                        ...data.groups.map((g) => ({
                          value: g.id,
                          label: g.name,
                        })),
                      ],
                    },
                  ]
                : []),
            ]}
          />
          <Card>
            <CardContent className="flex flex-wrap items-center gap-8">
              <div className="flex flex-col gap-1">
                <span className="text-sm text-muted-foreground">
                  {t("col.average")}
                </span>
                <AverageText
                  average={data.summary.average}
                  count={data.summary.count}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-sm text-muted-foreground">
                  {t("col.count")}
                </span>
                <span className="font-medium tabular-nums">
                  {data.summary.count}
                </span>
              </div>
              {data.summary.count > 0 && (
                <Distribution counts={data.summary.distribution} />
              )}
            </CardContent>
          </Card>
          {data.visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("detail.empty", { term: data.term.name })}
            </p>
          ) : (
            <ul className="flex flex-col gap-3" data-testid="ratings-list">
              {data.visible.map((r) => (
                <li key={r.id}>
                  <Card className="py-4">
                    <CardContent className="flex items-start justify-between gap-4">
                      {ratingBody(r)}
                      <HideRatingButton ratingId={r.id} hidden={false} />
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
          {data.hasMore && (
            <Link
              href={moreHref()}
              scroll={false}
              className={buttonVariants({
                variant: "outline",
                className: "self-center",
              })}
            >
              {t("detail.loadMore")}
            </Link>
          )}
          {data.hidden.length > 0 && (
            <details className="flex flex-col gap-2">
              <summary className="cursor-pointer font-medium">
                {t("detail.hiddenSection", { count: data.hidden.length })}
              </summary>
              <ul className="mt-2 flex flex-col gap-3">
                {data.hidden.map((r) => (
                  <li key={r.id}>
                    <Card className="bg-muted/50 py-4">
                      <CardContent className="flex items-start justify-between gap-4">
                        <div className="flex flex-col gap-1">
                          {ratingBody(r)}
                          <span className="text-xs text-muted-foreground">
                            {r.hiddenByName
                              ? t("detail.hiddenBy", {
                                  name: r.hiddenByName,
                                  date: date(r.hiddenAt),
                                })
                              : t("detail.hiddenByUnknown", {
                                  date: date(r.hiddenAt),
                                })}
                          </span>
                        </div>
                        <HideRatingButton ratingId={r.id} hidden />
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

export default function Page(props: PageProps<"/admin/ratings/[teacherId]">) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <TeacherRatingsPage {...props} />
    </Suspense>
  );
}
