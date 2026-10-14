import { getTranslations } from "next-intl/server";

import { Skeleton } from "@/components/ui/skeleton";
import { scopeToSchool } from "@/server/db/school-scope";
import { db } from "@/lib/db";
import type { Viewer } from "@/server/auth/access";
import { toZonedDateTime } from "@/server/scheduling";
import { loadWeek, loadWeekFilterOptions } from "@/server/timetable/views";
import { resolveWeek } from "@/server/timetable/week";

import { WeekView } from "./week-view";

type SearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidParam = (value: string | string[] | undefined) => {
  const v = first(value);
  return v && UUID.test(v) ? v : undefined;
};

/**
 * The weekly timetable page body for any role (timetable.md §6). The caller
 * has already checked the role with `requireRole`; data is loaded through
 * the school-scoped client and filtered by who the viewer is.
 */
export async function WeekPage({
  viewer,
  searchParams,
  title,
}: {
  viewer: Viewer;
  searchParams: SearchParams;
  title: string;
}) {
  const scoped = scopeToSchool(db, viewer.school.id);
  const now = toZonedDateTime(new Date(), viewer.school.timezone);
  const week = resolveWeek(first(searchParams.week), now.date);
  const filters =
    viewer.role === "ADMIN"
      ? {
          teacher: uuidParam(searchParams.teacher),
          room: uuidParam(searchParams.room),
          group: uuidParam(searchParams.group),
        }
      : undefined;
  const [data, filterOptions] = await Promise.all([
    loadWeek(scoped, { kind: viewer.role, userId: viewer.userId }, week, {
      teacherId: filters?.teacher,
      roomId: filters?.room,
      groupId: filters?.group,
    }),
    viewer.role === "ADMIN" ? loadWeekFilterOptions(scoped) : undefined,
  ]);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <WeekView
        data={data}
        role={viewer.role}
        today={now.date}
        nowMinute={now.minute}
        view={first(searchParams.view) === "day" ? "day" : "week"}
        filters={filters}
        filterOptions={filterOptions}
      />
    </div>
  );
}

export async function WeekPageSkeleton() {
  const t = await getTranslations("common");
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-8 w-80" />
      <div className="relative h-[480px] rounded-xl border bg-card">
        <Skeleton className="absolute top-16 left-24 h-20 w-32" />
        <Skeleton className="absolute top-40 left-72 h-24 w-32" />
        <Skeleton className="absolute top-64 left-[28rem] h-16 w-32" />
        <Skeleton className="absolute top-24 left-[40rem] h-20 w-32" />
      </div>
    </div>
  );
}
