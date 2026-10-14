import { getTranslations } from "next-intl/server";

import { getSchoolFormatter } from "@/i18n/school-format";
import type { Viewer } from "@/server/auth/access";
import { firstName, partOfDay } from "@/server/dashboard/greeting";

/** Page header of every dashboard: greeting + today's date (school time zone). */
export async function DashboardHeader({
  viewer,
  variant = "partOfDay",
}: {
  viewer: Viewer;
  variant?: "partOfDay" | "student";
}) {
  const t = await getTranslations("dashboard");
  const format = await getSchoolFormatter(viewer.school);
  const now = new Date();
  const name = { firstName: firstName(viewer.name) };

  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold">
        {variant === "student"
          ? t("studentGreeting", name)
          : t(`greeting.${partOfDay(now, viewer.school.timezone)}`, name)}
      </h1>
      <p className="text-sm text-muted-foreground">
        {t("today", { date: format.dateTime(now, "long") })}
      </p>
    </div>
  );
}
