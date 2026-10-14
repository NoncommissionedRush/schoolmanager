import { NotebookPen } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { ListFilters } from "@/components/admin/list-filters";
import { EmptyState } from "@/components/empty-state";
import { LessonList } from "@/components/lessons/lesson-list";
import { cn } from "@/lib/utils";
import { LESSON_FILTERS, type LessonFilter } from "@/server/lessons/rules";
import type { LessonList as LessonListData } from "@/server/lessons/teacher";

type SearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/** Filter parameters kept when switching the segmented filter. */
const KEPT = ["term", "group", "teacher"] as const;

/**
 * Lesson list page body (lessons.md §5.4, §7): segmented filter, group /
 * term (and for admins teacher) selects, then the list. Used by the
 * teacher's and the admin's list.
 */
export async function LessonListPage({
  basePath,
  list,
  filter,
  params,
  admin = false,
}: {
  basePath: "/teacher/lessons" | "/admin/lessons";
  list: LessonListData;
  filter: LessonFilter;
  params: SearchParams;
  admin?: boolean;
}) {
  const t = await getTranslations("lessons.list");

  const hrefFor = (next: LessonFilter) => {
    const query = new URLSearchParams();
    if (next !== "noLog") query.set("filter", next);
    for (const name of KEPT) {
      const value = first(params[name]);
      if (value) query.set(name, value);
    }
    const qs = query.toString();
    return qs ? `${basePath}?${qs}` : basePath;
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
            ...(admin
              ? [
                  {
                    name: "teacher",
                    label: t("filter.teacher"),
                    options: [
                      { value: "", label: t("filter.allTeachers") },
                      ...list.teachers.map((teacher) => ({
                        value: teacher.id,
                        label: teacher.name,
                      })),
                    ],
                  },
                ]
              : []),
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
        <EmptyState
          icon={NotebookPen}
          title={admin ? t(`adminEmpty.${filter}`) : t(`empty.${filter}`)}
        />
      ) : (
        <LessonList
          items={list.items}
          hrefPrefix={`${basePath}/`}
          hrefSuffix="?from=list"
          showTeacher={admin}
        />
      )}
    </div>
  );
}
