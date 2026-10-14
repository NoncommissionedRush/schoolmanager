import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { formatMinutes } from "@/components/timetable/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TodayLesson } from "@/server/lessons/teacher";

/**
 * Teacher dashboard "Today" list (app-layout.md §7.3): the teacher's
 * lessons today, with "−{n} · +{r}" next to a lesson with cancellations or
 * replacements (absences.md §6.3).
 */
export async function TodayCard({ lessons }: { lessons: TodayLesson[] }) {
  const t = await getTranslations("dashboard.teacher.today");
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-lg font-semibold">{t("title")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {lessons.length === 0 ? (
          <p className="text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {lessons.map((lesson) => {
              const changed =
                !lesson.cancelled &&
                (lesson.notComing > 0 || lesson.replacements > 0);
              return (
                <li key={lesson.id}>
                  <Link
                    href={`/teacher/lessons/${lesson.id}`}
                    className="flex min-h-11 items-center gap-3 rounded-md px-2 hover:bg-muted"
                  >
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {t("time", {
                        start: formatMinutes(lesson.startMinute),
                        end: formatMinutes(lesson.endMinute),
                      })}
                    </span>
                    <span
                      className={
                        lesson.cancelled
                          ? "min-w-0 flex-1 truncate text-muted-foreground line-through"
                          : "min-w-0 flex-1 truncate"
                      }
                    >
                      {lesson.groupName}
                      <span className="text-muted-foreground">
                        {" · "}
                        {lesson.roomName ?? t("noRoom")}
                      </span>
                    </span>
                    {lesson.cancelled && (
                      <span className="text-sm text-muted-foreground">
                        {t("cancelled")}
                      </span>
                    )}
                    {changed && (
                      <span className="text-sm font-medium tabular-nums">
                        <span aria-hidden="true">
                          {t("counts", {
                            notComing: lesson.notComing,
                            replacements: lesson.replacements,
                          })}
                        </span>
                        <span className="sr-only">
                          {t("countsLabel", {
                            notComing: lesson.notComing,
                            replacements: lesson.replacements,
                          })}
                        </span>
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
