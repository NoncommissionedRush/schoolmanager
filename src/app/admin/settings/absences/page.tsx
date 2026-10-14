import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/admin/list";
import { TableSkeleton } from "@/components/admin/table-skeleton";
import { getAbsenceSettings } from "@/server/admin/absence-settings/service";
import { adminContext } from "@/server/admin/context";
import {
  addDays,
  isoWeekday,
  toZonedDateTime,
  zonedTimeToUtc,
} from "@/server/scheduling";

import { AbsenceSettingsForm } from "./absence-settings-form";

/** Settings › Absences & credits (absences.md §7.1). */
async function AbsenceSettingsPage() {
  const { db } = await adminContext();
  const t = await getTranslations("settings.absences");
  const school = await getAbsenceSettings(db);
  // The live examples use a real lesson time: next Monday, 17:00.
  const today = toZonedDateTime(new Date(), school.timezone).date;
  const monday = addDays(today, 8 - isoWeekday(today));
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />
      <AbsenceSettingsForm
        settings={{
          cutoffHours: Math.floor(school.absenceCutoffMinutes / 60),
          validDays: school.makeupCreditValidDays,
          updatedAt: school.updatedAt.toISOString(),
        }}
        example={{
          lessonDate: monday,
          lessonStartsAt: zonedTimeToUtc(
            monday,
            17 * 60,
            school.timezone,
          ).toISOString(),
        }}
      />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <AbsenceSettingsPage />
    </Suspense>
  );
}
