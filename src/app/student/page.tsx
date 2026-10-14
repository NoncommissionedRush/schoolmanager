import { BookOpen } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { DashboardHeader } from "@/components/dashboard-header";
import { EmptyState } from "@/components/empty-state";
import { requireRole } from "@/server/auth/session";

export default async function StudentHomePage() {
  const viewer = await requireRole("STUDENT");
  const t = await getTranslations("dashboard.student");
  // Single column at every width (mobile-first, §7.4).
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 md:gap-6">
      <DashboardHeader viewer={viewer} variant="student" />
      <EmptyState
        icon={BookOpen}
        title={t("empty.title")}
        description={t("empty.description")}
      />
    </div>
  );
}
