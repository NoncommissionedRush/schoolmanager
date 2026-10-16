import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { LessonPageSkeleton } from "@/components/lessons/lesson-page-skeleton";
import { adminContext } from "@/server/admin/context";
import { loadAdminLesson } from "@/server/lessons/admin";
import { loadLessonNotes } from "@/server/notes/teacher-notes";
import { loadAdminRescheduleInfo } from "@/server/replacements/reschedule";
import { loadLessonRoster } from "@/server/replacements/views";
import { substituteLessonReasons } from "@/server/scheduling";
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
  const [internalNotes, roster, reschedule, row] = await Promise.all([
    loadLessonNotes(db, { role: viewer.role }, lesson.id, now),
    loadLessonRoster(db, lesson.id, now),
    loadAdminRescheduleInfo(db, lesson.id, now),
    db.lesson.findUniqueOrThrow({
      where: { id: lesson.id },
      select: {
        status: true,
        endsAt: true,
        substituteTeacherId: true,
        term: { select: { timetablePublishedAt: true } },
      },
    }),
  ]);
  // Phase 5 substitutes (rules §3.2): hidden when cancelled or too late.
  const substitute =
    substituteLessonReasons(row, {
      published: row.term.timetablePublishedAt !== null,
      now,
    }).length === 0
      ? { hasSubstitute: row.substituteTeacherId !== null }
      : null;

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
      reschedule={reschedule}
      substitute={substitute}
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
