import { BookOpen } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { DashboardHeader } from "@/components/dashboard-header";
import { EmptyState } from "@/components/empty-state";
import { LatestHomeworkCard } from "@/components/lessons/latest-homework-card";
import { loadLatestHomework } from "@/server/lessons/student";
import { studentContext } from "@/server/lessons/student-context";

export default async function StudentHomePage() {
  const { viewer, db, scope } = await studentContext();
  const t = await getTranslations("dashboard.student");
  const latest = await loadLatestHomework(
    db,
    scope,
    new Date(),
    viewer.school.timezone,
  );
  // Single column at every width (mobile-first, §7.4).
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 md:gap-6">
      <DashboardHeader viewer={viewer} variant="student" />
      {scope.memberships.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={t("empty.title")}
          description={t("empty.description")}
        />
      ) : (
        <LatestHomeworkCard items={latest} />
      )}
    </div>
  );
}
