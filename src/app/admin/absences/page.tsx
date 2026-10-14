import { CalendarX, Ticket } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { ToneBadge } from "@/components/absences/tone";
import { ListFilters } from "@/components/admin/list-filters";
import {
  listHref,
  PageHeader,
  Pagination,
  TableCard,
} from "@/components/admin/list";
import { TableSkeleton } from "@/components/admin/table-skeleton";
import { EmptyState } from "@/components/empty-state";
import { calendarDate, formatMinutes } from "@/components/timetable/format";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminContext } from "@/server/admin/context";
import { param } from "@/server/admin/list";
import { expireCredits } from "@/server/replacements/service";
import {
  defaultAbsencePeriod,
  listAdminAbsences,
  loadAbsenceFilterOptions,
} from "@/server/replacements/views";
import { addDays, isoWeekday, toZonedDateTime } from "@/server/scheduling";
import { parseIsoDateParam } from "@/server/timetable/week";

import {
  AbsenceRowActions,
  PeriodFilter,
  ReportAbsenceButton,
} from "./absences-client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidParam = (value: string) => (UUID.test(value) ? value : undefined);

/**
 * Admin Absences & replacements (absences.md §7.2), Absences tab: every
 * cancellation in the school for a lesson-date period, with its credit.
 * The Review and Replacements tabs arrive with replacement booking
 * (CARM-43).
 */
async function AdminAbsences({ searchParams }: PageProps<"/admin/absences">) {
  const { db, viewer } = await adminContext();
  const params = await searchParams;
  const now = new Date();
  const today = toZonedDateTime(now, viewer.school.timezone).date;
  const period = defaultAbsencePeriod(today);
  let from = parseIsoDateParam(param(params, "from"), period.from);
  let to = parseIsoDateParam(param(params, "to"), period.to);
  if (to < from) [from, to] = [to, from];
  const page = Math.max(1, Number.parseInt(param(params, "page"), 10) || 1);
  const filters = {
    from,
    to,
    studentId: uuidParam(param(params, "student")),
    groupId: uuidParam(param(params, "group")),
    teacherId: uuidParam(param(params, "teacher")),
    page,
  };

  await expireCredits(db, now);
  const [list, options] = await Promise.all([
    listAdminAbsences(db, filters, now),
    loadAbsenceFilterOptions(db),
  ]);
  const t = await getTranslations("adminAbsences");
  const format = await getFormatter();
  const date = (iso: string) =>
    format.dateTime(calendarDate(iso), {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const instant = (iso: string) =>
    format.dateTime(new Date(iso), {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  const monday = addDays(today, 1 - isoWeekday(today));
  const presets = [
    { label: t("preset.thisWeek"), from: monday, to: addDays(monday, 6) },
    { label: t("preset.next14"), from: today, to: addDays(today, 14) },
    { label: t("preset.last30"), from: addDays(today, -30), to: today },
  ];
  const hrefFor = (p: number) =>
    listHref("/admin/absences", {
      from,
      to,
      student: filters.studentId,
      group: filters.groupId,
      teacher: filters.teacherId,
      page: p,
    });
  const activeStudents = options.students.filter((s) => !s.archived);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={<ReportAbsenceButton students={activeStudents} />}
      />
      <div className="flex flex-col gap-3">
        <PeriodFilter from={from} to={to} presets={presets} />
        <ListFilters
          status={false}
          selects={[
            {
              name: "student",
              label: t("filter.student"),
              options: [
                { value: "", label: t("filter.all") },
                ...options.students.map((s) => ({
                  value: s.id,
                  label: s.name,
                })),
              ],
            },
            {
              name: "group",
              label: t("filter.group"),
              options: [
                { value: "", label: t("filter.all") },
                ...options.groups.map((g) => ({ value: g.id, label: g.name })),
              ],
            },
            {
              name: "teacher",
              label: t("filter.teacher"),
              options: [
                { value: "", label: t("filter.all") },
                ...options.teachers.map((x) => ({
                  value: x.id,
                  label: x.name,
                })),
              ],
            },
          ]}
        />
      </div>
      {list.total === 0 ? (
        <EmptyState icon={CalendarX} title={t("empty.absences")} />
      ) : (
        <>
          <TableCard>
            <Table>
              <TableCaption className="sr-only">{t("title")}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("col.lesson")}</TableHead>
                  <TableHead>{t("col.student")}</TableHead>
                  <TableHead>{t("col.cancelledAt")}</TableHead>
                  <TableHead>{t("col.reason")}</TableHead>
                  <TableHead>{t("col.credit")}</TableHead>
                  <TableHead>{t("col.creditStatus")}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t("col.actions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Link
                        href={`/admin/lessons/${row.lesson.id}`}
                        className="flex flex-col hover:underline"
                      >
                        <span className="tabular-nums">
                          {date(row.lesson.date)},{" "}
                          {formatMinutes(row.lesson.startMinute)}–
                          {formatMinutes(row.lesson.endMinute)}
                        </span>
                        <span className="text-muted-foreground">
                          {row.lesson.oneOnOne
                            ? t("groupOneOnOne", {
                                group: row.lesson.groupName,
                              })
                            : row.lesson.groupName}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/admin/students/${row.student.id}`}
                        className="hover:underline"
                      >
                        {row.student.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col gap-1">
                        <span className="tabular-nums">
                          {instant(row.reportedAt)}
                        </span>
                        {row.byAdmin && (
                          <span>
                            <ToneBadge tone="muted">
                              {t("byAdmin", { name: row.byAdmin })}
                            </ToneBadge>
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell
                      className="max-w-xs truncate"
                      title={row.reason ?? undefined}
                    >
                      {row.reason}
                    </TableCell>
                    <TableCell>
                      {row.credit ? (
                        <ToneBadge tone="success" icon={Ticket}>
                          {t("status.creditEarned")}
                        </ToneBadge>
                      ) : (
                        <ToneBadge tone="warning">
                          {t("status.lateNoCredit")}
                        </ToneBadge>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.credit?.state === "AVAILABLE"
                        ? t("creditAvailableUntil", {
                            date: date(row.credit.validUntil),
                          })
                        : row.credit?.state === "USED"
                          ? t("creditUsed")
                          : row.credit?.state === "EXPIRED"
                            ? t("creditExpired")
                            : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <AbsenceRowActions
                        absence={{
                          id: row.id,
                          studentId: row.student.id,
                          studentName: row.student.name,
                          lessonId: row.lesson.id,
                          date: row.lesson.date,
                          oneOnOne: row.lesson.oneOnOne,
                          creditUsed: row.credit?.state === "USED",
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCard>
          <Pagination
            window={list.window}
            total={list.total}
            hrefFor={hrefFor}
          />
        </>
      )}
    </div>
  );
}

export default function Page(props: PageProps<"/admin/absences">) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <AdminAbsences {...props} />
    </Suspense>
  );
}
