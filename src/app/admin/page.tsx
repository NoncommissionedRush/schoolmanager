import { School } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { DashboardHeader } from "@/components/dashboard-header";
import { EmptyState } from "@/components/empty-state";
import { requireRole } from "@/server/auth/session";

export default async function AdminDashboardPage() {
  // Layouts don't guard pages on their own; every page checks the role.
  const viewer = await requireRole("ADMIN");
  const t = await getTranslations("dashboard.admin");
  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <DashboardHeader viewer={viewer} />
      <EmptyState
        icon={School}
        title={t("empty.title")}
        description={t("empty.description")}
      />
    </div>
  );
}
