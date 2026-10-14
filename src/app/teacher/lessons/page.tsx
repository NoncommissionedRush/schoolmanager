import { NotebookPen } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { ListFilters } from "@/components/admin/list-filters";
import { TableSkeleton } from "@/components/admin/table-skeleton";
import { EmptyState } from "@/components/empty-state";
import { LessonList } from "@/components/lessons/lesson-list";
import { cn } from "@/lib/utils";
import { teacherContext } from "@/server/lessons/context";
import {
  LESSON_FILTERS,
  type LessonFilter,
  parseLessonFilter,
} from "@/server/lessons/rules";
import { listTeacherLessons } from "@/server/lessons/teacher";

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

async function TeacherLessons({ searchParams }: PageProps<"/teacher/lessons">) {
  const { db, teacherId, viewer } = await teacherContext();
  const params = await searchParams;
  const filter = parseLessonFilter(first(params.filter));
  const list = await listTeacherLessons(
    db,
    teacherId,
    { filter, termId: first(params.term), groupId: first(params.group) },
    new Date(),
    viewer.school.timezone,
  );
  const t = await getTranslations("lessons.list");

  const hrefFor = (next: LessonFilter) => {
    const query = new URLSearchParams();
    if (next !== "noLog") query.set("filter", next);
    const term = first(params.term);
    const group = first(params.group);
    if (term) query.set("term", term);
    if (group) query.set("group", group);
    const qs = query.toString();
    return qs ? `/teacher/lessons?${qs}` : "/teacher/lessons";
  };
  const label = (f: LessonFilter) =>
    f === "noLog"
      ? t("filter.noLog", { count: list.noLogCount })
      : t(`filter.${f}`);

  return (
    <div className="mx-auto flex max-w-screen-xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <nav aria-label={t("filter.label")}>
          <ul className="inline-flex rounded-lg border bg-muted p-0.5">
            {LESSON_FILTERS.map((f) => (
              <li key={f}>
                <Link
                  href={hrefFor(f)}
                  aria-current={f === filter ? "page" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center rounded-md px-3 text-sm font-medium",
                    f === filter
                      ? "bg-background shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label(f)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <ListFilters
          status={false}
          selects={[
            {
              name: "group",
              label: t("filter.group"),
              options: [
                { value: "", label: t("filter.allGroups") },
                ...list.groups.map((g) => ({ value: g.id, label: g.name })),
              ],
            },
            ...(list.terms.length > 1
              ? [
                  {
                    name: "term",
                    label: t("filter.term"),
                    defaultValue: list.termId ?? "",
                    options: list.terms.map((term) => ({
                      value: term.id,
                      label: term.name,
                    })),
                  },
                ]
              : []),
          ]}
        />
      </div>
      {list.termId === null ? (
        <EmptyState icon={NotebookPen} title={t("noTerm")} />
      ) : list.items.length === 0 ? (
        <EmptyState icon={NotebookPen} title={t(`empty.${filter}`)} />
      ) : (
        <LessonList
          items={list.items}
          hrefPrefix="/teacher/lessons/"
          hrefSuffix="?from=list"
        />
      )}
    </div>
  );
}

export default function Page(props: PageProps<"/teacher/lessons">) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <TeacherLessons {...props} />
    </Suspense>
  );
}
