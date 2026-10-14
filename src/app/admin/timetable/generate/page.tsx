import { CalendarRange, Users } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { TableSkeleton } from "@/components/admin/table-skeleton";
import { EmptyState } from "@/components/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { adminContext } from "@/server/admin/context";
import { param } from "@/server/admin/list";
import { toZonedDateTime } from "@/server/scheduling";
import { loadGeneratorPage } from "@/server/timetable/generator-page";

import { GeneratorClient } from "./generator-client";

async function AssignTeachers({
  searchParams,
}: PageProps<"/admin/timetable/generate">) {
  const { db, viewer } = await adminContext();
  const t = await getTranslations("generator");
  const te = await getTranslations("timetable.editor");
  const query = await searchParams;
  const today = toZonedDateTime(new Date(), viewer.school.timezone).date;
  const data = await loadGeneratorPage(db, {
    termParam: param(query, "term") || undefined,
    today,
  });

  if (!data.term) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <div className="flex flex-col items-center gap-4">
          <EmptyState
            icon={CalendarRange}
            title={te("empty.noTerm.title")}
            description={te("empty.noTerm.description")}
          />
          <Link href="/admin/settings/terms" className={buttonVariants()}>
            {te("empty.noTerm.action")}
          </Link>
        </div>
      </div>
    );
  }
  if (data.groups.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <div className="flex flex-col items-center gap-4">
          <EmptyState
            icon={Users}
            title={t("empty.noGroups.title")}
            description={t("empty.noGroups.description")}
          />
          <Link href="/admin/groups" className={buttonVariants()}>
            {t("empty.noGroups.action")}
          </Link>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="flex flex-col gap-4 lg:hidden">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <Alert>
          <AlertDescription>{t("desktopRecommended")}</AlertDescription>
        </Alert>
      </div>
      <div className="hidden lg:block">
        {/* Remount per term so dialogs and selections never leak across terms. */}
        <GeneratorClient
          key={data.term.id}
          data={data}
          tab={param(query, "tab") === "draft" ? "draft" : "groups"}
        />
      </div>
    </>
  );
}

export default function Page(props: PageProps<"/admin/timetable/generate">) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <AssignTeachers {...props} />
    </Suspense>
  );
}
