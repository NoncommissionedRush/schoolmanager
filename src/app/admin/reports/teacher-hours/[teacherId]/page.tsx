import { UserRoundCog } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getSchoolFormatter } from "@/i18n/school-format";
import { pageWindow } from "@/server/admin/list";
import { isUuid } from "@/server/lessons/access";
import { loadReport } from "@/server/reports/admin";
import { REPORT_PAGE_SIZE } from "@/server/reports/rules";
import { reportSearch } from "@/server/reports/schema";

import { notFoundOn, reportQuery } from "../../query";

const PATH = "/admin/reports/teacher-hours";

/**
 * One teacher's lessons in the period (reports.md §4.2, phase6-rules.md
 * §4.2): the lessons they taught, as regular teacher or substitute.
 */
async function TeacherLessonsPage({
  params,
  searchParams,
}: PageProps<"/admin/reports/teacher-hours/[teacherId]">) {
  const { teacherId } = await params;
  if (!isUuid(teacherId)) notFound();
  const query = await reportQuery(searchParams);
  const input = { ...query.input, teacherId };
  const loaded = await loadReport("teacher-hours-lessons", input).catch(
    notFoundOn,
  );
  const teacher = loaded.options.teachers.find((x) => x.id === teacherId)!;
  const t = await reportTranslator();
  const format = await getSchoolFormatter({ timezone: loaded.timeZone });
  const duration = (minutes: number) => formatDuration(t, minutes);
  const basePath = `${PATH}/${teacherId}`;

  let body = null;
  let empty = false;
  if (loaded.status === "ok") {
    const { rows, summary } = loaded.result;
    empty = rows.length === 0;
    const window = pageWindow(query.page, rows.length, REPORT_PAGE_SIZE);
    const shown = rows.slice(window.skip, window.skip + window.take);
    body = (
      <>
        <SummaryCards
          items={[
            {
              label: t("hours.stat.total"),
              value: duration(summary?.totalMinutes ?? 0),
            },
            { label: t("hours.stat.lessons"), value: summary?.lessons ?? 0 },
            {
              label: t("hours.stat.substitute"),
              value: duration(summary?.substituteMinutes ?? 0),
            },
          ]}
        />
        <TableCard>
          <div className="overflow-x-auto">
            <Table>
              <TableCaption className="sr-only">
                {t("hours.lessonsCaption", { teacher: teacher.name })}
              </TableCaption>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead aria-sort="ascending">
                    {t("hours.col.date")}
                  </TableHead>
                  <TableHead>{t("hours.col.time")}</TableHead>
                  <TableHead>{t("hours.col.group")}</TableHead>
                  <TableHead>{t("hours.col.level")}</TableHead>
                  <TableHead>{t("hours.col.room")}</TableHead>
                  <TableHead>{t("hours.col.role")}</TableHead>
                  <TableHead className="text-right">
                    {t("hours.col.duration")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((row) => (
                  <TableRow key={row.lessonId}>
                    <TableCell className="sticky left-0 bg-card font-medium">
                      <Link
                        href={`/admin/lessons/${row.lessonId}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {format.dateTime(row.startsAt, "short")}
                      </Link>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {t("hours.time", { start: row.start, end: row.end })}
                    </TableCell>
                    <TableCell>{row.groupName}</TableCell>
                    <TableCell>{row.levelCode}</TableCell>
                    <TableCell>{row.roomName ?? t("noValue")}</TableCell>
                    <TableCell>
                      {row.role === "SUBSTITUTE" ? (
                        <span className="inline-flex items-center gap-1 text-info">
                          <UserRoundCog aria-hidden="true" className="size-4" />
                          {t("hours.role.SUBSTITUTE", {
                            teacher: row.regularTeacherName,
                          })}
                        </span>
                      ) : (
                        t("hours.role.REGULAR")
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {duration(row.minutes)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TableCard>
        <Pagination
          window={window}
          total={rows.length}
          hrefFor={(p) =>
            `${basePath}${reportSearch(query.input, { page: p === 1 ? undefined : p })}`
          }
        />
      </>
    );
  }

  return (
    <ReportShell
      loaded={loaded}
      input={input}
      basePath={basePath}
      title={
        <span className="flex flex-wrap items-center gap-2">
          {teacher.name}
          {teacher.archived && <ArchivedBadge />}
        </span>
      }
      description={t("hours.title")}
      back={{
        href: `${PATH}${reportSearch({ ...query.input, teacherId: undefined })}`,
        label: t("hours.title"),
      }}
      exports={[
        { report: "teacher-hours-lessons", label: t("hours.export.lessons") },
      ]}
      selects={[
        {
          name: "group",
          label: t("filter.group"),
          options: filterOptions(t, loaded.options.groups),
        },
      ]}
      empty={empty}
      filtered={Object.keys(query.input).length > 0}
      footnotes={[t("hours.footnote")]}
    >
      {body}
    </ReportShell>
  );
}

export default function Page(
  props: PageProps<"/admin/reports/teacher-hours/[teacherId]">,
) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <TeacherLessonsPage {...props} />
    </Suspense>
  );
}
