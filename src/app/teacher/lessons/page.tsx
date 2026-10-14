import { Suspense } from "react";

import { TableSkeleton } from "@/components/admin/table-skeleton";
import { LessonListPage } from "@/components/lessons/lesson-list-page";
import { teacherContext } from "@/server/lessons/context";
import { parseLessonFilter } from "@/server/lessons/rules";
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
  return (
    <LessonListPage
      basePath="/teacher/lessons"
      list={list}
      filter={filter}
      params={params}
    />
  );
}

export default function Page(props: PageProps<"/teacher/lessons">) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <TeacherLessons {...props} />
    </Suspense>
  );
}
