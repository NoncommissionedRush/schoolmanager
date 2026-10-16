import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { PeriodFilter } from "@/app/admin/absences/absences-client";
import { PageHeader } from "@/components/admin/list";
import { ListFilters } from "@/components/admin/list-filters";
import { TableSkeleton } from "@/components/admin/table-skeleton";
import { adminContext } from "@/server/admin/context";
import { isUuid } from "@/server/lessons/access";
import {
  addDays,
  NEEDS_COVER_DAYS,
  toZonedDateTime,
} from "@/server/scheduling";
import {
  listCovered,
  listNeedsCover,
  listPastSubstitutions,
  substitutionCounts,
} from "@/server/substitutes/service";
import { parseIsoDateParam } from "@/server/timetable/week";

import { CoverTeacherButton, SubstitutionsList } from "./substitutions-client";

const TABS = ["needsCover", "covered", "past"] as const;
type Tab = (typeof TABS)[number];

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) ?? "";

/**
 * Substitutions (docs/design/notifications-substitutes.md §5.2): lessons
 * that need cover in the next 8 weeks, covered lessons and past
 * substitutions, filtered by regular teacher, dates and level; the tab and
 * filters live in the URL.
 */
async function Substitutions({
  searchParams,
}: PageProps<"/admin/substitutions">) {
  const { db, viewer } = await adminContext();
  const params = await searchParams;
  const now = new Date();
  const t = await getTranslations("substitutes");
  const tabParam = first(params.tab);
  const tab: Tab = (TABS as readonly string[]).includes(tabParam)
    ? (tabParam as Tab)
    : "needsCover";
  const today = toZonedDateTime(now, viewer.school.timezone).date;
  let from = parseIsoDateParam(first(params.from), today);
  let to = parseIsoDateParam(
    first(params.to),
    addDays(today, NEEDS_COVER_DAYS),
  );
  if (to < from) [from, to] = [to, from];
  const teacherId = isUuid(first(params.teacher))
    ? first(params.teacher)
    : undefined;
  const levelId = isUuid(first(params.level)) ? first(params.level) : undefined;
  // "Cover a teacher": every lesson of the teacher in the range.
  const allOfTeacher = first(params.all) === "1" && teacherId !== undefined;

  const [teachers, levels, terms] = await Promise.all([
    db.teacherProfile.findMany({
      where: { user: { deletedAt: null } },
      select: { id: true, user: { select: { name: true } } },
      orderBy: [{ user: { name: "asc" } }, { id: "asc" }],
    }),
    db.level.findMany({
      select: { id: true, name: true },
      orderBy: [{ rank: "asc" }, { id: "asc" }],
    }),
    db.term.findMany({
      where: { timetablePublishedAt: { not: null } },
      select: { id: true, name: true, startDate: true, endDate: true },
      orderBy: { startDate: "desc" },
    }),
  ]);
  const currentTerm =
    terms.find(
      (term) =>
        term.startDate.toISOString().slice(0, 10) <= today &&
        today <= term.endDate.toISOString().slice(0, 10),
    ) ?? terms[0];
  const termId = isUuid(first(params.term))
    ? first(params.term)
    : (currentTerm?.id ?? null);

  const filters = { from, to, teacherId, levelId };
  const [rows, counts] = await Promise.all([
    tab === "needsCover"
      ? listNeedsCover(db, { ...filters, allOfTeacher }, now)
      : tab === "covered"
        ? listCovered(db, filters, now)
        : listPastSubstitutions(db, { termId, teacherId, levelId }, now),
    substitutionCounts(db, now),
  ]);

  const tabHref = (key: Tab) => {
    const next = new URLSearchParams();
    if (key !== "needsCover") next.set("tab", key);
    for (const name of ["teacher", "level"] as const) {
      const value = first(params[name]);
      if (value) next.set(name, value);
    }
    const query = next.toString();
    return query ? `/admin/substitutions?${query}` : "/admin/substitutions";
  };
  const teacherName = teachers.find((x) => x.id === teacherId)?.user.name;

  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <PageHeader
        title={t("title")}
        actions={
          <CoverTeacherButton
            teachers={teachers.map((x) => ({ id: x.id, name: x.user.name }))}
            today={today}
          />
        }
      />
      <nav aria-label={t("tab.label")} className="flex gap-1 border-b">
        {TABS.map((key) => (
          <Link
            key={key}
            href={tabHref(key)}
            aria-current={tab === key ? "page" : undefined}
            className={
              tab === key
                ? "-mb-px border-b-2 border-primary px-3 py-2 text-sm font-medium"
                : "px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            }
          >
            {key === "needsCover"
              ? t("tab.needsCover", { count: counts.needsCover })
              : key === "covered"
                ? t("tab.covered", { count: counts.covered })
                : t("tab.past")}
          </Link>
        ))}
      </nav>
      <div className="flex flex-wrap items-end gap-3">
        <ListFilters
          status={false}
          selects={[
            {
              name: "teacher",
              label: t("filters.teacher"),
              options: [
                { value: "", label: t("filters.any") },
                ...teachers.map((x) => ({ value: x.id, label: x.user.name })),
              ],
            },
            {
              name: "level",
              label: t("filters.level"),
              options: [
                { value: "", label: t("filters.any") },
                ...levels.map((l) => ({ value: l.id, label: l.name })),
              ],
            },
            ...(tab === "past"
              ? [
                  {
                    name: "term",
                    label: t("filters.term"),
                    defaultValue: currentTerm?.id ?? "",
                    options: terms.map((term) => ({
                      value: term.id,
                      label: term.name,
                    })),
                  },
                ]
              : []),
          ]}
        />
        {tab !== "past" && <PeriodFilter from={from} to={to} presets={[]} />}
      </div>
      {allOfTeacher && teacherName && (
        <p className="text-sm text-muted-foreground" role="status">
          {t("coverTeacher.showing", { teacher: teacherName, from, to })}{" "}
          <Link
            href="/admin/substitutions"
            className="text-primary underline-offset-4 hover:underline"
          >
            {t("coverTeacher.clear")}
          </Link>
        </p>
      )}
      <SubstitutionsList
        tab={tab}
        rows={rows}
        emptyTeacher={allOfTeacher ? (teacherName ?? null) : null}
        filtered={teacherId !== undefined || levelId !== undefined}
        now={now.toISOString()}
      />
    </div>
  );
}

export default function Page(props: PageProps<"/admin/substitutions">) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <Substitutions {...props} />
    </Suspense>
  );
}
