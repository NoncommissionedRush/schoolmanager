import { Suspense } from "react";
import { getLocale, getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/admin/list";
import { weekdayName, type Weekday } from "@/lib/i18n/dates";
import { adminContext } from "@/server/admin/context";
import { timeZoneOptions } from "@/server/admin/school/schema";
import { getSchoolSettings } from "@/server/admin/school/service";
import { formatMinutes } from "@/server/scheduling";

import { SchoolSettingsForm } from "./school-form";
import { TableSkeleton } from "@/components/admin/table-skeleton";

async function SchoolSettingsPage() {
  const { db } = await adminContext();
  const t = await getTranslations("settings.school");
  const locale = await getLocale();
  const school = await getSchoolSettings(db);
  const weekdays = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    value: String(day),
    // ISO 7 = Sunday = JS 0.
    label: weekdayName(locale, (day % 7) as Weekday),
  }));
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />
      <SchoolSettingsForm
        school={{
          name: school.name,
          timezone: school.timezone,
          timezoneLocked: school.timezoneLocked,
          teachingWeekdays: school.teachingWeekdays.map(String),
          dayStart: formatMinutes(school.dayStartMinute),
          // 24:00 can't be typed into a time input.
          dayEnd: formatMinutes(Math.min(school.dayEndMinute, 23 * 60 + 59)),
          updatedAt: school.updatedAt.toISOString(),
        }}
        timezones={timeZoneOptions(school.timezone)}
        weekdays={weekdays}
      />
    </div>
  );
}

// Own Suspense boundary: client navigations between admin pages re-render
// below the shared layout, so the shell's boundary doesn't cover them.
export default function Page() {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <SchoolSettingsPage />
    </Suspense>
  );
}
