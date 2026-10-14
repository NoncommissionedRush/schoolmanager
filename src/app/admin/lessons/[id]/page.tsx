import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { LessonPageSkeleton } from "@/components/lessons/lesson-page-skeleton";
import { adminContext } from "@/server/admin/context";
import { loadAdminLesson } from "@/server/lessons/admin";
import { loadLessonNotes } from "@/server/notes/teacher-notes";
import { loadLessonRoster } from "@/server/replacements/views";
import { mondayOf } from "@/server/timetable/week";

import { AdminLessonClient } from "./lesson-page-client";

/** Admin lesson page (lessons.md §7): the teacher page, read-only. */
async function AdminLesson({
  params,
  searchParams,
}: PageProps<"/admin/lessons/[id]">) {
  const { db, viewer } = await adminContext();
  const { id } = await params;
  const now = new Date();
  const lesson = await loadAdminLesson(db, id, now, viewer.school.timezone);
  if (!lesson) notFound();
  const [internalNotes, roster] = await Promise.all([
    loadLessonNotes(db, { role: viewer.role }, lesson.id, now),
    loadLessonRoster(db, lesson.id, now),
  ]);

  const t = await getTranslations("lessons.back");
  const fromList = (await searchParams).from === "list";
  const timetableHref = `/admin/timetable?week=${mondayOf(lesson.date)}&group=${lesson.group.id}`;
  const back = fromList
    ? { href: "/admin/lessons", label: t("list") }
    : { href: timetableHref, label: t("adminTimetable") };
  return (
    <AdminLessonClient
      key={lesson.id}
      lesson={lesson}
      internalNotes={internalNotes}
      roster={roster}
      back={back}
      query={fromList ? "?from=list" : ""}
      timetableHref={timetableHref}
      slotHref={
        lesson.slotId
          ? `/admin/timetable/edit?term=${lesson.termId}&slot=${lesson.slotId}&asOf=${lesson.date}`
          : null
      }
    />
  );
}

export default function Page(props: PageProps<"/admin/lessons/[id]">) {
  return (
    <Suspense fallback={<LessonPageSkeleton />}>
      <AdminLesson {...props} />
    </Suspense>
  );
}
