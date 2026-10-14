import { ClipboardList } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { calendarDate } from "@/components/timetable/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LatestHomework } from "@/server/lessons/student";

/**
 * Student home card "Latest homework" (lessons.md §6.3): the homework from
 * the most recent lesson of each group, then "See all".
 */
export async function LatestHomeworkCard({
  items,
}: {
  items: LatestHomework[];
}) {
  const t = await getTranslations("homework.home");
  const format = await getFormatter();
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>
          <h2 className="text-lg font-semibold">{t("title")}</h2>
        </CardTitle>
        <Link
          href="/student/homework"
          className="inline-flex min-h-11 items-center text-sm text-primary hover:underline"
        >
          {t("seeAll")}
        </Link>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item) => {
              const body = (
                <>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {format.dateTime(calendarDate(item.date), {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                      timeZone: "UTC",
                    })}{" "}
                    · {item.group.name}
                  </span>
                  <span className="flex gap-2">
                    <ClipboardList
                      aria-hidden="true"
                      className="mt-1 size-4 shrink-0 text-primary"
                    />
                    <span className="break-words whitespace-pre-wrap">
                      {item.homework}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={item.group.id}>
                  {item.lessonId ? (
                    <Link
                      href={`/student/lessons/${item.lessonId}`}
                      className="-mx-2 flex min-h-11 flex-col gap-1 rounded-md px-2 py-1 hover:bg-muted"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="flex flex-col gap-1">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
