import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { WeekPage, WeekPageSkeleton } from "@/components/timetable/week-page";
import { requireRole } from "@/server/auth/session";

async function TeacherTimetable({
  searchParams,
}: PageProps<"/teacher/timetable">) {
  const viewer = await requireRole("TEACHER");
  const t = await getTranslations("timetable");
  return (
    <WeekPage
      viewer={viewer}
      searchParams={await searchParams}
      title={t("myTitle")}
    />
  );
}

export default function Page(props: PageProps<"/teacher/timetable">) {
  return (
    <Suspense fallback={<WeekPageSkeleton />}>
      <TeacherTimetable {...props} />
    </Suspense>
  );
}
