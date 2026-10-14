import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { LessonPageSkeleton } from "@/components/lessons/lesson-page-skeleton";
import { mondayOf } from "@/server/timetable/week";
import { teacherContext } from "@/server/lessons/context";
import { loadTeacherLesson } from "@/server/lessons/teacher";
import { loadLessonNotes } from "@/server/notes/teacher-notes";

import { TeacherLessonClient } from "./lesson-page-client";

async function TeacherLesson({
  params,
  searchParams,
}: PageProps<"/teacher/lessons/[id]">) {
  const { db, teacherId, noteViewer, viewer } = await teacherContext();
  const { id } = await params;
  const now = new Date();
  // A lesson the teacher doesn't teach or substitute is "not found" (§2).
  const lesson = await loadTeacherLesson(
    db,
    teacherId,
    id,
    now,
    viewer.school.timezone,
  );
  if (!lesson) notFound();
  const internalNotes = await loadLessonNotes(db, noteViewer, lesson.id, now);

  const t = await getTranslations("lessons.back");
  const fromList = (await searchParams).from === "list";
  const back = fromList
    ? { href: "/teacher/lessons", label: t("list") }
    : {
        href: `/teacher/timetable?week=${mondayOf(lesson.date)}`,
        label: t("timetable"),
      };
  return (
    <TeacherLessonClient
      key={lesson.id}
      lesson={lesson}
      internalNotes={internalNotes}
      back={back}
      query={fromList ? "?from=list" : ""}
    />
  );
}

export default function Page(props: PageProps<"/teacher/lessons/[id]">) {
  return (
    <Suspense fallback={<LessonPageSkeleton />}>
      <TeacherLesson {...props} />
    </Suspense>
  );
}
