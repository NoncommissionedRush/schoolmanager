import { getTranslations } from "next-intl/server";

import { Skeleton } from "@/components/ui/skeleton";

/** Loading state of a lesson page (lessons.md §5.2 "States"). */
export async function LessonPageSkeleton() {
  const t = await getTranslations("common");
  return (
    <div
      className="mx-auto flex max-w-screen-xl flex-col gap-6"
      aria-busy="true"
    >
      <span className="sr-only">{t("loading")}</span>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-5 w-96 max-w-full" />
      <div className="grid gap-6 lg:grid-cols-12">
        <Skeleton className="h-80 lg:col-span-8" />
        <Skeleton className="h-64 lg:col-span-4" />
      </div>
    </div>
  );
}
