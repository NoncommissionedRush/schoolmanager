import { Lock } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { ToneAlert } from "@/components/absences/tone";
import { PageHeader } from "@/components/admin/list";
import { StudentPageSkeleton } from "@/components/lessons/student-homework";
import { getSchoolFormatter } from "@/i18n/school-format";
import { db } from "@/lib/db";
import { requireRole } from "@/server/auth/session";
import { scopeToSchool } from "@/server/db/school-scope";
import { loadRatingForm } from "@/server/ratings/student";

import { RatingForm } from "./rating-form";

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/** Rate a teacher (notifications-substitutes.md §6.4). Not eligible → 404. */
async function RateTeacher({
  params,
  searchParams,
}: PageProps<"/student/ratings/[teacherId]">) {
  const viewer = await requireRole("STUDENT");
  const { teacherId } = await params;
  const form = await loadRatingForm(
    scopeToSchool(db, viewer.school.id),
    viewer.userId,
    teacherId,
    first((await searchParams).term),
    new Date(),
    viewer.school.timezone,
  );
  if (!form) notFound();
  const t = await getTranslations("ratings.form");
  const format = await getSchoolFormatter(viewer.school);
  const teacher = form.teacher.name;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 text-base">
      <PageHeader
        back={{ href: "/student/ratings", label: t("back") }}
        title={t("title", { teacher })}
        description={[form.term.name, ...form.groups].join(" · ")}
      />
      <ToneAlert tone="info" icon={Lock}>
        {t("privacy", { teacher })}
      </ToneAlert>
      <RatingForm
        teacherId={form.teacher.id}
        termId={form.term.id}
        termName={form.term.name}
        initial={
          form.rating && {
            score: form.rating.score,
            comment: form.rating.comment ?? "",
            lastChanged: format.dateTime(form.rating.updatedAt, "short"),
          }
        }
        editable={form.editable}
      />
    </div>
  );
}

export default function Page(props: PageProps<"/student/ratings/[teacherId]">) {
  return (
    <Suspense fallback={<StudentPageSkeleton />}>
      <RateTeacher {...props} />
    </Suspense>
  );
}
