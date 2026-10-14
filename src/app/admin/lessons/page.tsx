import { Suspense } from "react";

import { TableSkeleton } from "@/components/admin/table-skeleton";
import { LessonListPage } from "@/components/lessons/lesson-list-page";
import { adminContext } from "@/server/admin/context";
import { listAdminLessons } from "@/server/lessons/admin";
import { parseLessonFilter } from "@/server/lessons/rules";

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/** Admin lesson list (lessons.md §7): read-only, the whole school. */
async function AdminLessons({ searchParams }: PageProps<"/admin/lessons">) {
  const { db, viewer } = await adminContext();
  const params = await searchParams;
  const filter = parseLessonFilter(first(params.filter));
  const list = await listAdminLessons(
    db,
    {
      filter,
      termId: first(params.term),
      groupId: first(params.group),
      teacherId: first(params.teacher),
    },
    new Date(),
    viewer.school.timezone,
  );
  return (
    <LessonListPage
      basePath="/admin/lessons"
      list={list}
      filter={filter}
      params={params}
      admin
    />
  );
}

export default function Page(props: PageProps<"/admin/lessons">) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <AdminLessons {...props} />
    </Suspense>
  );
}
