"use client";

import { ClipboardList } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { useDateFormat } from "@/components/timetable/format";
import {
  InternalNotesCard,
  type NoteActions,
} from "@/components/lessons/internal-notes-card";
import {
  LessonHeader,
  SubstituteBanner,
} from "@/components/lessons/lesson-header";
import { LessonLogCard } from "@/components/lessons/lesson-log-form";
import { LinkifiedText } from "@/components/lessons/linkified-text";
import { UnsavedChangesGuard } from "@/components/lessons/unsaved-guard";
import { Card, CardContent } from "@/components/ui/card";
import type { TeacherLessonPage } from "@/server/lessons/teacher";
import type { LessonNotes } from "@/server/notes/teacher-notes";

import {
  createNoteAction,
  deleteNoteAction,
  loadEarlierNotesAction,
  saveLessonLogAction,
  updateNoteAction,
} from "../actions";

const noteActions: NoteActions = {
  create: createNoteAction,
  update: updateNoteAction,
  remove: deleteNoteAction,
};

/** Teacher lesson page body (lessons.md §5.2–5.3). */
export function TeacherLessonClient({
  lesson,
  internalNotes,
  back,
  query,
}: {
  lesson: TeacherLessonPage;
  internalNotes: LessonNotes;
  back: { href: string; label: string };
  /** Kept on previous/next links (e.g. `?from=list`). */
  query: string;
}) {
  const t = useTranslations("lessons");
  const tl = useTranslations("lessonLog");
  const formatDate = useDateFormat();
  const [dirty, setDirty] = useState(false);
  const href = (id: string | null) =>
    id ? `/teacher/lessons/${id}${query}` : null;

  const banner =
    lesson.relation === "substituting" ? (
      <SubstituteBanner
        text={t("substitute.you", { teacher: lesson.teacherName })}
      />
    ) : lesson.substituteName ? (
      <SubstituteBanner
        text={t("substitute.other", { substitute: lesson.substituteName })}
      />
    ) : null;

  return (
    <div className="mx-auto flex max-w-screen-xl flex-col gap-6">
      <LessonHeader
        lesson={lesson}
        back={back}
        previousHref={href(lesson.previousLessonId)}
        nextHref={href(lesson.nextLessonId)}
        banners={banner}
      />
      <div className="grid gap-6 lg:grid-cols-12 lg:items-start">
        <div className="flex flex-col gap-6 lg:col-span-8">
          {/* Remount when moving to another lesson so the form starts fresh. */}
          <LessonLogCard
            key={lesson.id}
            lessonId={lesson.id}
            lock={lesson.lock}
            log={lesson.log}
            save={saveLessonLogAction}
            onDirtyChange={setDirty}
          />
          {lesson.previousHomework && (
            <Card size="sm">
              <CardContent className="flex flex-col gap-1">
                <h2 className="flex items-center gap-1.5 text-sm font-medium">
                  <ClipboardList aria-hidden="true" className="size-4" />
                  {tl("previousHomework", {
                    date: formatDate(
                      lesson.previousHomework.date,
                      "weekdayDate",
                    ),
                  })}
                </h2>
                <LinkifiedText
                  text={lesson.previousHomework.homework}
                  className="text-muted-foreground"
                />
              </CardContent>
            </Card>
          )}
        </div>
        <div className="lg:sticky lg:top-20 lg:col-span-4">
          <InternalNotesCard
            key={lesson.id}
            lessonId={lesson.id}
            groupName={lesson.group.name}
            students={lesson.students}
            initial={internalNotes}
            actions={noteActions}
            loadEarlier={loadEarlierNotesAction}
          />
        </div>
      </div>
      <UnsavedChangesGuard dirty={dirty} />
    </div>
  );
}
