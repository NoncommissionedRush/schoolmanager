import { ClipboardList, Users } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { ListFilters } from "@/components/admin/list-filters";
import { EmptyState } from "@/components/empty-state";
import {
  HomeworkLessonCard,
  StudentPageSkeleton,
} from "@/components/lessons/student-homework";
import { calendarDate } from "@/components/timetable/format";
import { buttonVariants } from "@/components/ui/button";
import { listStudentHomework } from "@/server/lessons/student";
import { studentContext } from "@/server/lessons/student-context";
import {
  groupByMonth,
  HOMEWORK_PAGE,
  parseShown,
} from "@/server/lessons/student-rules";

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/** Student Homework tab (lessons.md §6.2): lesson history, newest first. */
async function StudentHomework({
  searchParams,
}: PageProps<"/student/homework">) {
  const { db, scope, viewer } = await studentContext();
  const params = await searchParams;
  const shown = parseShown(first(params.shown));
  const data = await listStudentHomework(
    db,
    scope,
    { groupId: first(params.group), shown },
    new Date(),
    viewer.school.timezone,
  );
  const t = await getTranslations("homework");
  const tt = await getTranslations("timetable.empty");
  const format = await getFormatter();

  const moreHref = () => {
    const query = new URLSearchParams();
    if (data.groupId) query.set("group", data.groupId);
    query.set("shown", String(shown + HOMEWORK_PAGE));
    return `/student/homework?${query}`;
  };

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 text-base">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      {scope.memberships.length === 0 ? (
        <EmptyState icon={Users} title={tt("noGroups")} />
      ) : (
        <>
          {data.groups.length > 1 && (
            <ListFilters
              status={false}
              selects={[
                {
                  name: "group",
                  label: t("group"),
                  options: [
                    { value: "", label: t("allGroups") },
                    ...data.groups.map((g) => ({ value: g.id, label: g.name })),
                  ],
                },
              ]}
            />
          )}
          {data.items.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title={t("empty.title")}
              description={t("empty.description")}
            />
          ) : (
            groupByMonth(data.items).map(({ month, items }) => (
              <section key={month} className="flex flex-col gap-3">
                <h2 className="text-lg font-semibold">
                  {format.dateTime(calendarDate(`${month}-01`), {
                    month: "long",
                    year: "numeric",
                    timeZone: "UTC",
                  })}
                </h2>
                <ul className="flex flex-col gap-3">
                  {items.map((lesson) => (
                    <li key={lesson.id}>
                      <HomeworkLessonCard lesson={lesson} />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
          {data.hasMore && (
            <Link
              href={moreHref()}
              scroll={false}
              className={buttonVariants({
                variant: "outline",
                size: "lg",
                className: "self-center",
              })}
            >
              {t("loadMore")}
            </Link>
          )}
        </>
      )}
    </div>
  );
}

export default function Page(props: PageProps<"/student/homework">) {
  return (
    <Suspense fallback={<StudentPageSkeleton />}>
      <StudentHomework {...props} />
    </Suspense>
  );
}
