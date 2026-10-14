import { CalendarX, CircleCheck, Repeat, Ticket } from "lucide-react";
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
import { pageWindow, param } from "@/server/admin/list";
import {
  countReviewQueue,
  listAdminReplacements,
  listReviewQueue,
} from "@/server/replacements/booking";
import { expireCredits } from "@/server/replacements/service";
import {
  defaultAbsencePeriod,
  listAdminAbsences,
  loadAbsenceFilterOptions,
} from "@/server/replacements/views";
import {
  addDays,
  isoWeekday,
  toZonedDateTime,
  zonedTimeToUtc,
} from "@/server/scheduling";
import { parseIsoDateParam } from "@/server/timetable/week";

import {
  AbsenceRowActions,
  PeriodFilter,
  ReportAbsenceButton,
} from "./absences-client";
import {
  BookingRowActions,
  IssuesCell,
  LessonCell,
  ReviewTable,
  StatusBadge,
} from "./review-client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidParam = (value: string) => (UUID.test(value) ? value : undefined);

const TABS = ["review", "replacements", "absences"] as const;
type Tab = (typeof TABS)[number];
const STATUSES = [
  "AUTO_APPROVED",
  "APPROVED",
  "REJECTED",
  "OVERRIDDEN",
  "CANCELLED",
] as const;

/**
 * Admin Absences & replacements (absences.md §7.2), three tabs in the URL
 * (`?tab=`): Review (unreviewed bookings with live issues), Replacements
 * (every booking in a period) and Absences (every cancellation with its
 * credit).
 */
async function AdminAbsences({ searchParams }: PageProps<"/admin/absences">) {
  const { db, viewer } = await adminContext();
  const params = await searchParams;
  const now = new Date();
  const tabParam = param(params, "tab");
  const tab: Tab = (TABS as readonly string[]).includes(tabParam)
    ? (tabParam as Tab)
    : "absences";
  const today = toZonedDateTime(now, viewer.school.timezone).date;
  const period =
    tab === "replacements"
      ? { from: today, to: addDays(today, 14) }
      : defaultAbsencePeriod(today);
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

  const statusParam = param(params, "status");
  const status = (STATUSES as readonly string[]).includes(statusParam)
    ? statusParam
    : undefined;

  await expireCredits(db, now);
  const [list, options, reviewCount] = await Promise.all([
    tab === "absences"
      ? listAdminAbsences(db, filters, now)
      : { total: 0, window: pageWindow(1, 0), rows: [] },
    loadAbsenceFilterOptions(db),
    countReviewQueue(db, now),
  ]);
  const ta = await getTranslations("adminAbsences.tab");
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
      ...(tab !== "absences" && { tab }),
      ...(status && { status }),
      page: p,
    });
  const activeStudents = options.students.filter((s) => !s.archived);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          tab === "absences" ? (
            <ReportAbsenceButton students={activeStudents} />
          ) : undefined
        }
      />
      <nav aria-label={ta("label")} className="flex gap-1 border-b">
        {TABS.map((key) => (
          <Link
            key={key}
            href={
              key === "absences"
                ? "/admin/absences"
                : `/admin/absences?tab=${key}`
            }
            aria-current={tab === key ? "page" : undefined}
            className={
              tab === key
                ? "-mb-px border-b-2 border-primary px-3 py-2 text-sm font-medium"
                : "px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            }
          >
            {key === "review" ? ta("review", { count: reviewCount }) : ta(key)}
          </Link>
        ))}
      </nav>
      {tab === "review" ? (
        <ReviewTab />
      ) : tab === "replacements" ? (
        <ReplacementsTab
          filters={{ ...filters, status }}
          presets={presets}
          options={options}
          hrefFor={hrefFor}
          timeZone={viewer.school.timezone}
        />
      ) : (
        <>
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
                    ...options.groups.map((g) => ({
                      value: g.id,
                      label: g.name,
                    })),
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
        </>
      )}
    </div>
  );
}

/** The Review tab (§7.3): AUTO_APPROVED bookings not started, issues first. */
async function ReviewTab() {
  const { db } = await adminContext();
  const rows = await listReviewQueue(db, new Date());
  const t = await getTranslations("adminAbsences.empty");
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={CircleCheck}
        title={t("reviewTitle")}
        description={t("reviewDescription")}
      />
    );
  }
  return <ReviewTable rows={rows} />;
}

/** The Replacements tab (§7.2): every booking with a lesson in the period. */
async function ReplacementsTab({
  filters,
  presets,
  options,
  hrefFor,
  timeZone,
}: {
  filters: {
    from: string;
    to: string;
    studentId?: string;
    groupId?: string;
    teacherId?: string;
    status?: string;
    page: number;
  };
  presets: { label: string; from: string; to: string }[];
  options: Awaited<ReturnType<typeof loadAbsenceFilterOptions>>;
  hrefFor: (page: number) => string;
  timeZone: string;
}) {
  const { db } = await adminContext();
  const now = new Date();
  const t = await getTranslations("adminAbsences");
  const format = await getFormatter();
  const where = {
    from: zonedTimeToUtc(filters.from, 0, timeZone),
    until: zonedTimeToUtc(addDays(filters.to, 1), 0, timeZone),
    studentId: filters.studentId,
    groupId: filters.groupId,
    teacherId: filters.teacherId,
    status: filters.status,
  };
  const list = await listAdminReplacements(db, where, filters.page, now);
  const all = { value: "", label: t("filter.all") };
  return (
    <>
      <div className="flex flex-col gap-3">
        <PeriodFilter from={filters.from} to={filters.to} presets={presets} />
        <ListFilters
          status={false}
          selects={[
            {
              name: "status",
              label: t("filter.status"),
              options: [
                all,
                { value: "AUTO_APPROVED", label: t("status.needsReview") },
                { value: "APPROVED", label: t("status.approved") },
                { value: "OVERRIDDEN", label: t("status.overridden") },
                { value: "REJECTED", label: t("status.rejected") },
                { value: "CANCELLED", label: t("status.cancelledByStudent") },
              ],
            },
            {
              name: "student",
              label: t("filter.student"),
              options: [
                all,
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
                all,
                ...options.groups.map((g) => ({ value: g.id, label: g.name })),
              ],
            },
            {
              name: "teacher",
              label: t("filter.teacher"),
              options: [
                all,
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
        <EmptyState icon={Repeat} title={t("empty.replacements")} />
      ) : (
        <>
          <TableCard>
            <Table>
              <TableCaption className="sr-only">
                {t("tab.replacements")}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("col.student")}</TableHead>
                  <TableHead>{t("col.from")}</TableHead>
                  <TableHead>{t("col.to")}</TableHead>
                  <TableHead>{t("col.status")}</TableHead>
                  <TableHead>{t("col.reviewedBy")}</TableHead>
                  <TableHead>{t("col.booked")}</TableHead>
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
                        href={`/admin/students/${row.student.id}`}
                        className="hover:underline"
                      >
                        {row.student.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <LessonCell lesson={row.from} />
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col gap-1">
                        <LessonCell lesson={row.to} />
                        <IssuesCell row={row} />
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col items-start gap-1">
                        <StatusBadge row={row} />
                        {row.reviewNote && (
                          <span
                            className="max-w-xs truncate text-xs text-muted-foreground"
                            title={row.reviewNote}
                          >
                            {row.reviewNote}
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.reviewedBy && row.reviewedAt
                        ? t("reviewedBy", {
                            name: row.reviewedBy,
                            dateTime: format.dateTime(
                              new Date(row.reviewedAt),
                              {
                                day: "numeric",
                                month: "short",
                                hour: "2-digit",
                                minute: "2-digit",
                              },
                            ),
                          })
                        : null}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {format.dateTime(new Date(row.bookedAt), {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      <BookingRowActions row={row} />
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
    </>
  );
}

export default function Page(props: PageProps<"/admin/absences">) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <AdminAbsences {...props} />
    </Suspense>
  );
}
