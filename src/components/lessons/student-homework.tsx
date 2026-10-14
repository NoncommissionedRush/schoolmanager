import { Ban, ClipboardList } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { calendarDate } from "@/components/timetable/format";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { StudentLessonView } from "@/server/lessons/student";

/**
 * One lesson on the student Homework tab (lessons.md §6.2): a full-width
 * link with the date and group, the homework in full, and a 2-line excerpt
 * of "We covered". Cancelled lessons are muted and dashed.
 */
export async function HomeworkLessonCard({
  lesson,
}: {
  lesson: StudentLessonView;
}) {
  const t = await getTranslations("homework");
  const tl = await getTranslations("lessons.status");
  const format = await getFormatter();
  const cancelled = lesson.status === "CANCELLED";
  const date = format.dateTime(calendarDate(lesson.date), {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return (
    <Link
      href={`/student/lessons/${lesson.id}`}
      className={cn(
        "flex min-h-11 flex-col gap-2 rounded-xl border bg-card p-4 text-base hover:bg-muted/50",
        cancelled && "border-dashed bg-muted/40 text-muted-foreground",
      )}
    >
      <span className="flex flex-wrap items-center gap-x-2 font-medium tabular-nums">
        <span>{date}</span>
        <span aria-hidden="true">·</span>
        <span>{lesson.group.name}</span>
        {cancelled && (
          <span className="inline-flex items-center gap-1 text-sm">
            <Ban aria-hidden="true" className="size-4" />
            {tl("cancelled")}
          </span>
        )}
      </span>
      {lesson.homework ? (
        <span className="flex gap-2">
          <ClipboardList
            aria-hidden="true"
            className="mt-1 size-4 shrink-0 text-primary"
          />
          {/* Never truncated (§9). Links work on the lesson page. */}
          <span className="break-words whitespace-pre-wrap">
            {lesson.homework}
          </span>
        </span>
      ) : lesson.content ? (
        <span className="text-muted-foreground">{t("none")}</span>
      ) : null}
      {lesson.content ? (
        <span className="line-clamp-2 text-sm whitespace-pre-line text-muted-foreground">
          {t("weCovered", { text: lesson.content })}
        </span>
      ) : (
        !lesson.homework &&
        !cancelled && (
          <span className="text-sm text-muted-foreground">
            {t("nothingYet")}
          </span>
        )
      )}
    </Link>
  );
}

/** Loading state of the Homework tab and the student lesson page. */
export async function StudentPageSkeleton() {
  const t = await getTranslations("common");
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
    </div>
  );
}
