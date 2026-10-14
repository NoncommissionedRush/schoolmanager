"use client";

import { CalendarDays, Info, SquarePen } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { InternalNotesCard } from "@/components/lessons/internal-notes-card";
import {
  LessonHeader,
  SubstituteBanner,
} from "@/components/lessons/lesson-header";
import { ReadOnlyLogCard } from "@/components/lessons/lesson-log-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import type { LessonPage } from "@/server/lessons/teacher";
import type { LessonNotes } from "@/server/notes/teacher-notes";

import { loadEarlierNotesAction } from "../actions";

/**
 * Admin lesson page body (lessons.md §7): the teacher page's layout, read
 * only — the log as text and the internal notes without the add form.
 */
export function AdminLessonClient({
  lesson,
  internalNotes,
  back,
  query,
  timetableHref,
  slotHref,
}: {
  lesson: LessonPage;
  internalNotes: LessonNotes;
  back: { href: string; label: string };
  /** Kept on previous/next links (e.g. `?from=list`). */
  query: string;
  timetableHref: string;
  slotHref: string | null;
}) {
  const t = useTranslations("lessons");
  const tl = useTranslations("lessonLog");
  const href = (id: string | null) =>
    id ? `/admin/lessons/${id}${query}` : null;

  return (
    <div className="mx-auto flex max-w-screen-xl flex-col gap-6">
      <LessonHeader
        lesson={lesson}
        back={back}
        previousHref={href(lesson.previousLessonId)}
        nextHref={href(lesson.nextLessonId)}
        banners={
          <>
            {lesson.substituteName && (
              <SubstituteBanner
                text={t("substitute.admin", {
                  substitute: lesson.substituteName,
                  teacher: lesson.teacherName,
                })}
              />
            )}
            <Alert className="border-info-border bg-info-surface text-info">
              <Info aria-hidden="true" />
              <AlertDescription className="text-info">
                {t("admin.readOnlyHint")}
              </AlertDescription>
            </Alert>
          </>
        }
      />
      <div className="flex flex-wrap gap-2">
        <Link
          href={timetableHref}
          className={buttonVariants({ variant: "outline" })}
        >
          <CalendarDays aria-hidden="true" />
          {t("admin.openInTimetable")}
        </Link>
        {slotHref && (
          <Link
            href={slotHref}
            className={buttonVariants({ variant: "outline" })}
          >
            <SquarePen aria-hidden="true" />
            {t("admin.openSlot")}
          </Link>
        )}
      </div>
      <div className="grid gap-6 lg:grid-cols-12 lg:items-start">
        <div className="flex flex-col gap-6 lg:col-span-8">
          <ReadOnlyLogCard
            log={lesson.log}
            empty={
              lesson.lock === "notStarted"
                ? tl("readOnly.notStarted")
                : tl("readOnly.empty")
            }
          />
        </div>
        <div className="lg:sticky lg:top-20 lg:col-span-4">
          <InternalNotesCard
            key={lesson.id}
            lessonId={lesson.id}
            groupName={lesson.group.name}
            students={lesson.students}
            initial={internalNotes}
            actions={null}
            loadEarlier={loadEarlierNotesAction}
          />
        </div>
      </div>
    </div>
  );
}
