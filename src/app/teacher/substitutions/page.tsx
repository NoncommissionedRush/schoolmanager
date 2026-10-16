import { UserRoundCog } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/admin/list";
import { TableSkeleton } from "@/components/admin/table-skeleton";
import { EmptyState } from "@/components/empty-state";
import { SubstitutionSection } from "@/components/substitutes/teacher-substitutions";
import { buttonVariants } from "@/components/ui/button";
import { teacherContext } from "@/server/lessons/context";
import { listTeacherSubstitutions } from "@/server/substitutes/service";

/**
 * The teacher's Substitutions (design §5.5): lessons they cover and lessons
 * covered for them, upcoming first, past with `?past=1`. Read-only:
 * substitutes are arranged by the admins.
 */
async function TeacherSubstitutions({
  searchParams,
}: PageProps<"/teacher/substitutions">) {
  const { viewer, db, teacherId } = await teacherContext();
  const t = await getTranslations("substitutes.teacher");
  const past = (await searchParams).past === "1";
  const lists = teacherId
    ? await listTeacherSubstitutions(db, teacherId, { past }, new Date())
    : { covering: [], coveredForMe: [] };
  const empty = lists.covering.length === 0 && lists.coveredForMe.length === 0;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader
        title={t("title")}
        actions={
          <Link
            href={
              past ? "/teacher/substitutions" : "/teacher/substitutions?past=1"
            }
            className={buttonVariants({ variant: "outline" })}
          >
            {past ? t("showUpcoming") : t("showPast")}
          </Link>
        }
      />
      {empty ? (
        <EmptyState
          icon={UserRoundCog}
          title={t("empty.title")}
          description={t("empty.description")}
        />
      ) : (
        <>
          <SubstitutionSection
            viewer={viewer}
            title={t("covering")}
            rows={lists.covering}
            kind="covering"
          />
          <SubstitutionSection
            viewer={viewer}
            title={t("coveredForYou")}
            rows={lists.coveredForMe}
            kind="coveredForMe"
          />
        </>
      )}
    </div>
  );
}

export default function Page(props: PageProps<"/teacher/substitutions">) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <TeacherSubstitutions {...props} />
    </Suspense>
  );
}
