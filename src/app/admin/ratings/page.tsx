import { Lock } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { ToneAlert } from "@/components/absences/tone";
import { ListFilters } from "@/components/admin/list-filters";
import { ArchivedBadge, PageHeader, TableCard } from "@/components/admin/list";
import { TableSkeleton } from "@/components/admin/table-skeleton";
import { AverageText, Distribution } from "@/components/ratings/distribution";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getSchoolFormatter } from "@/i18n/school-format";
import { adminContext } from "@/server/admin/context";
import { param } from "@/server/admin/list";
import {
  adminRatingsOverview,
  type RatingsOverviewRow,
} from "@/server/ratings/admin";

type Sort = "teacher" | "average" | "count";
const SORTS: readonly Sort[] = ["teacher", "average", "count"];

function sortRows(rows: RatingsOverviewRow[], sort: Sort) {
  const byName = (a: RatingsOverviewRow, b: RatingsOverviewRow) =>
    a.name.localeCompare(b.name);
  if (sort === "teacher") return rows;
  return [...rows].sort((a, b) =>
    sort === "count"
      ? b.summary.count - a.summary.count || byName(a, b)
      : (b.summary.average ?? -1) - (a.summary.average ?? -1) ||
        b.summary.count - a.summary.count ||
        byName(a, b),
  );
}

/** _Ratings_ (notifications-substitutes.md §6.5). Admins only. */
async function RatingsPage({ searchParams }: PageProps<"/admin/ratings">) {
  const { viewer } = await adminContext();
  const query = await searchParams;
  const data = await adminRatingsOverview(param(query, "term") || undefined);
  const t = await getTranslations("ratings.admin");
  const format = await getSchoolFormatter(viewer.school);
  const sortParam = param(query, "sort") as Sort;
  const sort: Sort =
    sortParam && SORTS.includes(sortParam) ? sortParam : "teacher";
  const rows = sortRows(data.rows, sort);
  const anyRatings = rows.some((r) => r.summary.count > 0);

  const sortHref = (value: Sort) => {
    const next = new URLSearchParams();
    if (data.term) next.set("term", data.term.id);
    if (value !== "teacher") next.set("sort", value);
    const qs = next.toString();
    return qs ? `/admin/ratings?${qs}` : "/admin/ratings";
  };
  const sortable = (value: Sort, label: string) => (
    <TableHead
      aria-sort={
        sort === value
          ? value === "teacher"
            ? "ascending"
            : "descending"
          : undefined
      }
    >
      <Link
        href={sortHref(value)}
        scroll={false}
        className="underline-offset-4 hover:underline"
      >
        {label}
      </Link>
    </TableHead>
  );

  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <PageHeader title={t("title")} />
      <ToneAlert tone="info" icon={Lock}>
        {t("adminsOnly")}
      </ToneAlert>
      {!data.term ? (
        <p className="text-sm text-muted-foreground">{t("noTerms")}</p>
      ) : (
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
            ]}
          />
          {!anyRatings && (
            <div className="flex flex-col gap-1">
              <h2 className="font-medium">
                {t("empty.title", { term: data.term.name })}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("empty.description", {
                  date: format.dateTime(data.term.opensAt, "short"),
                })}
              </p>
            </div>
          )}
          <TableCard>
            <Table>
              <TableCaption className="sr-only">
                {t("caption", { term: data.term.name })}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  {sortable("teacher", t("col.teacher"))}
                  {sortable("average", t("col.average"))}
                  {sortable("count", t("col.count"))}
                  <TableHead>{t("col.distribution")}</TableHead>
                  <TableHead>{t("col.lastRated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.teacherId}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        <Link
                          href={`/admin/ratings/${row.teacherId}?term=${data.term!.id}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {row.name}
                        </Link>
                        {row.archived && <ArchivedBadge />}
                      </span>
                    </TableCell>
                    <TableCell>
                      <AverageText
                        average={row.summary.average}
                        count={row.summary.count}
                      />
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.summary.count}
                    </TableCell>
                    <TableCell>
                      {row.summary.count > 0 ? (
                        <Distribution counts={row.summary.distribution} />
                      ) : (
                        t("noValue")
                      )}
                    </TableCell>
                    <TableCell>
                      {row.summary.lastRatedAt
                        ? format.dateTime(row.summary.lastRatedAt, "short")
                        : t("noValue")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCard>
        </>
      )}
    </div>
  );
}

export default function Page(props: PageProps<"/admin/ratings">) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <RatingsPage {...props} />
    </Suspense>
  );
}
