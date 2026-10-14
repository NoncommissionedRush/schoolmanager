import { CalendarRange } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { WeekPageSkeleton } from "@/components/timetable/week-page";
import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { adminContext } from "@/server/admin/context";
import { param } from "@/server/admin/list";
import { toZonedDateTime } from "@/server/scheduling";
import { loadEditor } from "@/server/timetable/editor-data";
import { parseIsoDateParam } from "@/server/timetable/week";

import { DesktopOnlyNotice, EditorClient } from "./editor-client";

async function TimetableEditor({
  searchParams,
}: PageProps<"/admin/timetable/edit">) {
  const { db, viewer } = await adminContext();
  const t = await getTranslations("timetable.editor");
  const query = await searchParams;
  const today = toZonedDateTime(new Date(), viewer.school.timezone).date;
  const asOfParam = param(query, "asOf");
  const data = await loadEditor(db, {
    termParam: param(query, "term") || undefined,
    asOfParam: asOfParam ? parseIsoDateParam(asOfParam, today) : undefined,
    today,
  });

  if (!data.term) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <div className="flex flex-col items-center gap-4">
          <EmptyState
            icon={CalendarRange}
            title={t("empty.noTerm.title")}
            description={t("empty.noTerm.description")}
          />
          <Link href="/admin/settings/terms" className={buttonVariants()}>
            {t("empty.noTerm.action")}
          </Link>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="lg:hidden">
        <DesktopOnlyNotice />
      </div>
      <div className="hidden lg:block">
        {/* Remount per term so sheet and dialog state never leak across terms. */}
        <EditorClient key={data.term.id} data={data} />
      </div>
    </>
  );
}

export default function Page(props: PageProps<"/admin/timetable/edit">) {
  return (
    <Suspense fallback={<WeekPageSkeleton />}>
      <TimetableEditor {...props} />
    </Suspense>
  );
}
