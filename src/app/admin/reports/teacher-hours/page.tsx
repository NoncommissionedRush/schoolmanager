import { UserRoundCog } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { ArchivedBadge, Pagination, TableCard } from "@/components/admin/list";
import { TableSkeleton } from "@/components/admin/table-skeleton";
import {
  filterOptions,
  formatDuration,
  ReportShell,
  reportTranslator,
  SummaryCards,
} from "@/components/reports/report-shell";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { pageWindow } from "@/server/admin/list";
import { loadReport } from "@/server/reports/admin";
import { REPORT_PAGE_SIZE } from "@/server/reports/rules";
import { reportSearch } from "@/server/reports/schema";

import { notFoundOn, reportQuery } from "../query";

const PATH = "/admin/reports/teacher-hours";

/** _Teacher hours_ (reports.md §4.2, phase6-rules.md §4.1). Admins only. */
async function TeacherHoursPage({
  searchParams,
}: PageProps<"/admin/reports/teacher-hours">) {
  const query = await reportQuery(searchParams);
  const { input } = query;
  const loaded = await loadReport("teacher-hours", input).catch(notFoundOn);
  const t = await reportTranslator();
  const duration = (minutes: number) => formatDuration(t, minutes);

  let body = null;
  let empty = false;
  if (loaded.status === "ok") {
    const { rows, totals } = loaded.result;
    empty = rows.length === 0;
    const window = pageWindow(query.page, rows.length, REPORT_PAGE_SIZE);
    const shown = rows.slice(window.skip, window.skip + window.take);
    const num = "text-right tabular-nums";
    body = (
      <>
        <SummaryCards
          items={[
            {
              label: t("hours.stat.total"),
              value: duration(totals.totalMinutes),
            },
            { label: t("hours.stat.lessons"), value: totals.lessons },
            {
              label: t("hours.stat.substitute"),
              value: duration(totals.substituteMinutes),
            },
          ]}
        />
        <TableCard>
          <div className="overflow-x-auto">
            <Table>
              <TableCaption className="sr-only">
                {t("hours.description")}
              </TableCaption>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead aria-sort="ascending">
                    {t("hours.col.teacher")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("hours.col.lessons")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("hours.col.regular")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("hours.col.substitute")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("hours.col.total")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("hours.col.coveredByOthers")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((row) => (
                  <TableRow key={row.teacherId}>
                    <TableCell className="sticky left-0 bg-card font-medium">
                      <span className="flex items-center gap-2">
                        <Link
                          href={`${PATH}/${row.teacherId}${reportSearch({ ...input, teacherId: undefined })}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {row.name}
                        </Link>
                        {row.archived && <ArchivedBadge />}
                      </span>
                    </TableCell>
                    <TableCell className={num}>{row.lessons}</TableCell>
                    <TableCell className={num}>
                      {duration(row.regularMinutes)}
                    </TableCell>
                    <TableCell className={num}>
                      {row.substituteMinutes > 0 ? (
                        <span className="inline-flex items-center gap-1 text-info">
                          <UserRoundCog aria-hidden="true" className="size-4" />
                          {duration(row.substituteMinutes)}
                        </span>
                      ) : (
                        duration(0)
                      )}
                    </TableCell>
                    <TableCell className={`${num} font-medium`}>
                      {duration(row.totalMinutes)}
                    </TableCell>
                    <TableCell className={`${num} text-muted-foreground`}>
                      {duration(row.coveredByOthersMinutes)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>{t("totals")}</TableCell>
                  <TableCell className={num}>{totals.lessons}</TableCell>
                  <TableCell className={num}>
                    {duration(totals.regularMinutes)}
                  </TableCell>
                  <TableCell className={num}>
                    {duration(totals.substituteMinutes)}
                  </TableCell>
                  <TableCell className={num}>
                    {duration(totals.totalMinutes)}
                  </TableCell>
                  <TableCell className={`${num} text-muted-foreground`}>
                    {duration(totals.coveredByOthersMinutes)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </TableCard>
        <Pagination
          window={window}
          total={rows.length}
          hrefFor={(p) =>
            `${PATH}${reportSearch(input, { page: p === 1 ? undefined : p })}`
          }
        />
      </>
    );
  }

  return (
    <ReportShell
      loaded={loaded}
      input={input}
      basePath={PATH}
      title={t("hours.title")}
      description={t("hours.description")}
      back={{ href: "/admin/reports", label: t("back") }}
      exports={[
        { report: "teacher-hours", label: t("hours.export.summary") },
        { report: "teacher-hours-lessons", label: t("hours.export.lessons") },
      ]}
      selects={[
        {
          name: "teacher",
          label: t("filter.teacher"),
          options: filterOptions(t, loaded.options.teachers),
        },
        {
          name: "group",
          label: t("filter.group"),
          options: filterOptions(t, loaded.options.groups),
        },
      ]}
      empty={empty}
      footnotes={[t("hours.footnote")]}
    >
      {body}
    </ReportShell>
  );
}

export default function Page(props: PageProps<"/admin/reports/teacher-hours">) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <TeacherHoursPage {...props} />
    </Suspense>
  );
}
