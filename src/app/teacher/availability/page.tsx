import { CalendarClock } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/admin/list";
import { TableSkeleton } from "@/components/admin/table-skeleton";
import { AvailabilityEditor } from "@/components/availability/availability-editor";
import { EmptyState } from "@/components/empty-state";
import { listAvailability } from "@/server/admin/availability/service";
import { schoolToday } from "@/server/admin/shared";
import { listRequests } from "@/server/availability-requests/service";
import { teacherContext } from "@/server/lessons/context";
import { toIsoDate } from "@/server/scheduling/time";

/**
 * The teacher's own availability (availability-requests.md §3): the rules
 * the timetable uses now, and the changes waiting for an admin.
 */
async function TeacherAvailability() {
  const { viewer, db, teacherId } = await teacherContext();
  const t = await getTranslations("availabilityRequests.page");
  if (!teacherId) {
    return (
      <EmptyState
        icon={CalendarClock}
        title={t("noProfile.title")}
        description={t("noProfile.description")}
      />
    );
  }
  const now = new Date();
  const todayIso = toIsoDate(schoolToday(viewer.school.timezone, now));
  const [availability, requests, school] = await Promise.all([
    listAvailability(db, teacherId),
    listRequests(db, teacherId, now),
    db.school.findFirstOrThrow({ select: { teachingWeekdays: true } }),
  ]);
  return (
    <AvailabilityEditor
      mode="teacher"
      teacherId={teacherId}
      name={viewer.name}
      teachingWeekdays={school.teachingWeekdays}
      weekly={availability.weekly}
      exceptions={availability.exceptions.map((exception) => ({
        ...exception,
        past: exception.date < todayIso,
      }))}
      requests={requests}
    />
  );
}

export default async function Page() {
  const t = await getTranslations("availabilityRequests.page");
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader title={t("title")} />
      <Suspense fallback={<TableSkeleton />}>
        <TeacherAvailability />
      </Suspense>
    </div>
  );
}
