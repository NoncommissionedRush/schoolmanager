import { User, Users } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { ArchivedBadge, Pagination, TableCard } from "@/components/admin/list";
import { TableSkeleton } from "@/components/admin/table-skeleton";
import {
  filterOptions,
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
import {
  type AttendanceSort,
  formatRate,
  REPORT_PAGE_SIZE,
  sortAttendance,
} from "@/server/reports/rules";
import { reportSearch } from "@/server/reports/schema";

import { notFoundOn, reportQuery } from "../query";

const PATH = "/admin/reports/attendance";

/** _Attendance_ report (reports.md §4.1, phase6-rules.md §3). Admins only. */
async function AttendancePage({
  searchParams,
}: PageProps<"/admin/reports/attendance">) {
  const query = await reportQuery(searchParams);
  const loaded = await loadReport("attendance", query.input).catch(notFoundOn);
  const t = await reportTranslator();
  const { input, sort, direction } = query;
  const rate = (tenths: number | null) =>
    tenths === null
      ? t("noValue")
      : t("attendance.rate", { rate: formatRate(tenths) });

  let body = null;
  let empty = false;
  if (loaded.status === "ok") {
    const { rows, totals } = loaded.result;
    empty = rows.length === 0;
    const sorted = sortAttendance(rows, sort, direction);
    const window = pageWindow(query.page, sorted.length, REPORT_PAGE_SIZE);
    const shown = sorted.slice(window.skip, window.skip + window.take);
    const href = (extra: Record<string, string | number | undefined>) =>
      `${PATH}${reportSearch(input, extra)}`;
    const sortHeader = (key: AttendanceSort, label: string, numeric = true) => {
      const active = sort === key;
      const next = active && direction === "asc" ? "desc" : "asc";
      return (
        <TableHead
          className={numeric ? "text-right" : undefined}
          aria-sort={
            active
              ? direction === "asc"
                ? "ascending"
                : "descending"
              : undefined
          }
        >
          <Link
            href={href({
              sort: key === "group" && next === "asc" ? undefined : key,
              dir: next === "asc" ? undefined : next,
            })}
            scroll={false}
            aria-label={t("sortBy", { column: label })}
            className="underline-offset-4 hover:underline"
          >
            {label}
          </Link>
        </TableHead>
      );
    };
    const absentDetail = (withCredit: number, late: number) =>
      t("attendance.col.absentDetail", { withCredit, late });

    body = (
      <>
        <SummaryCards
          items={[
            { label: t("attendance.stat.expected"), value: totals.expected },
            {
              label: t("attendance.stat.attended"),
              value: totals.attended,
              detail: rate(totals.attendanceRate),
            },
            {
              label: t("attendance.stat.absent"),
              value: totals.absent,
              detail: absentDetail(totals.absentWithCredit, totals.absentLate),
            },
            {
              label: t("attendance.stat.makeups"),
              value: totals.makeupsAttended,
            },
          ]}
        />
        <TableCard>
          <div className="overflow-x-auto">
            <Table>
              <TableCaption className="sr-only">
                {t("attendance.description")}
              </TableCaption>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  {sortHeader("student", t("attendance.col.student"), false)}
                  {sortHeader("group", t("attendance.col.group"), false)}
                  {sortHeader("expected", t("attendance.col.expected"))}
                  {sortHeader("absent", t("attendance.col.absent"))}
                  {sortHeader("attended", t("attendance.col.attended"))}
                  {sortHeader("rate", t("attendance.col.rate"))}
                  {sortHeader("makeups", t("attendance.col.makeups"))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((row) => {
                  const Icon = row.groupType === "ONE_ON_ONE" ? User : Users;
                  return (
                    <TableRow key={`${row.groupId}|${row.studentId}`}>
                      <TableCell className="sticky left-0 bg-card font-medium">
                        <span className="flex items-center gap-2">
                          <Link
                            href={`/admin/students/${row.studentId}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {row.studentName}
                          </Link>
                          {row.studentArchived && <ArchivedBadge />}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <Icon
                            aria-label={t(
                              `attendance.groupType.${row.groupType}`,
                            )}
                            className="size-4 text-muted-foreground"
                          />
                          {row.groupName}
                          <span className="text-muted-foreground">
                            {row.levelCode}
                          </span>
                          {row.groupArchived && <ArchivedBadge />}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.expected}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <div>{row.absent}</div>
                        {row.absent > 0 && (
                          <div className="text-xs text-muted-foreground">
                            {absentDetail(row.absentWithCredit, row.absentLate)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.attended}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {rate(row.attendanceRate)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.makeupsAttended}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={2}>{t("totals")}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {totals.expected}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {totals.absent}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {totals.attended}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {rate(totals.attendanceRate)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {totals.makeupsAttended}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </TableCard>
        <Pagination
          window={window}
          total={sorted.length}
          hrefFor={(p) =>
            href({
              sort: sort === "group" ? undefined : sort,
              dir: direction === "asc" ? undefined : direction,
              page: p === 1 ? undefined : p,
            })
          }
        />
      </>
    );
  }

  const { options } = loaded;
  return (
    <ReportShell
      loaded={loaded}
      input={input}
      basePath={PATH}
      title={t("attendance.title")}
      description={t("attendance.description")}
      caption={t("attendance.caption")}
      back={{ href: "/admin/reports", label: t("back") }}
      exports={[{ report: "attendance", label: t("export.label") }]}
      selects={[
        {
          name: "group",
          label: t("filter.group"),
          options: filterOptions(t, options.groups),
        },
        {
          name: "teacher",
          label: t("filter.teacher"),
          options: filterOptions(t, options.teachers),
        },
        {
          name: "student",
          label: t("filter.student"),
          options: filterOptions(t, options.students),
        },
      ]}
      empty={empty}
    >
      {body}
    </ReportShell>
  );
}

export default function Page(props: PageProps<"/admin/reports/attendance">) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <AttendancePage {...props} />
    </Suspense>
  );
}
