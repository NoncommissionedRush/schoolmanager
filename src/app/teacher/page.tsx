import { CalendarDays } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { DashboardHeader } from "@/components/dashboard-header";
import { EmptyState } from "@/components/empty-state";
import { requireRole } from "@/server/auth/session";

export default async function TeacherDashboardPage() {
  const viewer = await requireRole("TEACHER");
  const t = await getTranslations("dashboard.teacher");
  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <DashboardHeader viewer={viewer} />
      <EmptyState
        icon={CalendarDays}
        title={t("empty.title")}
        description={t("empty.description")}
      />
    </div>
  );
}
