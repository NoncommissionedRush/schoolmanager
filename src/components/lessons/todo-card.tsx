import { NotebookPen } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { calendarDate } from "@/components/timetable/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LessonListItem } from "@/server/lessons/teacher";

/**
 * Teacher dashboard "To do" card (lessons.md §5.1): lessons of the last 14
 * days without a log, oldest first.
 */
export async function TodoCard({ items }: { items: LessonListItem[] }) {
  const t = await getTranslations("lessons.todo");
  const format = await getFormatter();
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>
          <h2 className="text-lg font-semibold">{t("title")}</h2>
        </CardTitle>
        <Link
          href="/teacher/lessons"
          className="text-sm text-primary hover:underline"
        >
          {t("seeAll")}
        </Link>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/teacher/lessons/${item.id}`}
                  className="flex min-h-11 items-center gap-2 rounded-md px-2 hover:bg-muted"
                >
                  <NotebookPen
                    aria-hidden="true"
                    className="size-4 shrink-0 text-warning"
                  />
                  {t("writeLog", {
                    group: item.group.name,
                    date: format.dateTime(calendarDate(item.date), {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                      timeZone: "UTC",
                    }),
                  })}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
