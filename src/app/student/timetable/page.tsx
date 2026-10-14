import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { WeekPage, WeekPageSkeleton } from "@/components/timetable/week-page";
import { requireRole } from "@/server/auth/session";

async function StudentTimetable({
  searchParams,
}: PageProps<"/student/timetable">) {
  const viewer = await requireRole("STUDENT");
  const t = await getTranslations("timetable");
  // Mobile-first (§6.5): the agenda below 768 px, the grid above.
  return (
    <WeekPage
      viewer={viewer}
      searchParams={await searchParams}
      title={t("title")}
    />
  );
}

export default function Page(props: PageProps<"/student/timetable">) {
  return (
    <Suspense fallback={<WeekPageSkeleton />}>
      <StudentTimetable {...props} />
    </Suspense>
  );
}
