import { ChevronLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { StudentPageSkeleton } from "@/components/lessons/student-homework";
import { LinkifiedText } from "@/components/lessons/linkified-text";
import { calendarDate, formatMinutes } from "@/components/timetable/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { loadStudentLesson } from "@/server/lessons/student";
import { studentContext } from "@/server/lessons/student-context";
import { mondayOf } from "@/server/timetable/week";

/**
 * Student lesson page (lessons.md §6.4): the homework and "What we covered".
 * Built from the student-safe DTO only — never internal notes or other
 * students' names. Lessons the student may not read are "not found".
 */
async function StudentLesson({
  params,
  searchParams,
}: PageProps<"/student/lessons/[id]">) {
  const { db, scope, viewer } = await studentContext();
  const { id } = await params;
  const lesson = await loadStudentLesson(
    db,
    scope,
    id,
    new Date(),
    viewer.school.timezone,
  );
  if (!lesson) notFound();

  const t = await getTranslations("homework");
  const tl = await getTranslations("lessons");
  const tt = await getTranslations("timetable");
  const tr = await getTranslations("scheduling.cancelReasons");
  const tc = await getTranslations("common");
  const format = await getFormatter();
  const fromTimetable = (await searchParams).from === "timetable";
  const back = fromTimetable
    ? {
        href: `/student/timetable?week=${mondayOf(lesson.date)}`,
        label: t("back.timetable"),
      }
    : { href: "/student/homework", label: t("back.homework") };
  const reason = lesson.cancelReason
    ? tr.has(lesson.cancelReason as "HOLIDAY")
      ? tr(lesson.cancelReason as "HOLIDAY")
      : lesson.cancelReason
    : null;

  return (
    <article className="mx-auto flex max-w-md flex-col gap-6 text-base">
      <header className="flex flex-col gap-2">
        <Link
          href={back.href}
          className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          {back.label}
        </Link>
        <h1 className="text-2xl font-semibold">{lesson.group.name}</h1>
        <p className="flex flex-wrap gap-x-2 gap-y-1 text-muted-foreground tabular-nums">
          <span>
            {format.dateTime(calendarDate(lesson.date), {
              weekday: "short",
              day: "numeric",
              month: "short",
              year: "numeric",
              timeZone: "UTC",
            })}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {formatMinutes(lesson.startMinute)}–
            {formatMinutes(lesson.endMinute)}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {lesson.substituteName
              ? t("lesson.substitute", { name: lesson.substituteName })
              : lesson.teacherName}
          </span>
          <span aria-hidden="true">·</span>
          <span>{lesson.room?.name ?? tt("details.noRoom")}</span>
        </p>
        {lesson.room?.online && lesson.room.meetingUrl && (
          <a
            href={lesson.room.meetingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({
              variant: "outline",
              size: "lg",
              className: "self-start",
            })}
          >
            <ExternalLink aria-hidden="true" />
            {tt("details.joinOnline")}
            <span className="sr-only">{tc("opensInNewTab")}</span>
          </a>
        )}
        {lesson.status === "CANCELLED" && (
          <Alert className="border-danger-border bg-danger-surface text-danger">
            <AlertDescription className="text-danger">
              {reason
                ? tl("cancelledBanner", { reason })
                : tl("cancelledNoReason")}
            </AlertDescription>
          </Alert>
        )}
      </header>
      <section aria-labelledby="homework" className="flex flex-col gap-2">
        <h2 id="homework" className="text-lg font-semibold">
          {t("title")}
        </h2>
        {lesson.homework ? (
          <LinkifiedText text={lesson.homework} />
        ) : (
          <p className="text-muted-foreground">{t("noneForLesson")}</p>
        )}
      </section>
      <section aria-labelledby="covered" className="flex flex-col gap-2">
        <h2 id="covered" className="text-lg font-semibold">
          {t("lesson.covered")}
        </h2>
        {lesson.content ? (
          <LinkifiedText text={lesson.content} />
        ) : (
          <p className="text-muted-foreground">{t("lesson.logNotYet")}</p>
        )}
      </section>
    </article>
  );
}

export default function Page(props: PageProps<"/student/lessons/[id]">) {
  return (
    <Suspense fallback={<StudentPageSkeleton />}>
      <StudentLesson {...props} />
    </Suspense>
  );
}
