import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { WeekPage, WeekPageSkeleton } from "@/components/timetable/week-page";
import { requireRole } from "@/server/auth/session";

async function AdminTimetable({ searchParams }: PageProps<"/admin/timetable">) {
  const viewer = await requireRole("ADMIN");
  const t = await getTranslations("timetable");
  return (
    <WeekPage
      viewer={viewer}
      searchParams={await searchParams}
      title={t("title")}
    />
  );
}

export default function Page(props: PageProps<"/admin/timetable">) {
  return (
    <Suspense fallback={<WeekPageSkeleton />}>
      <AdminTimetable {...props} />
    </Suspense>
  );
}
