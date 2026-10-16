import { UserRoundCog } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSchoolFormatter } from "@/i18n/school-format";
import type { Viewer } from "@/server/auth/access";
import type { SubstitutionRow } from "@/server/substitutes/service";

async function whenFormatter(viewer: Viewer) {
  const format = await getSchoolFormatter(viewer.school);
  return (row: SubstitutionRow) => {
    const start = new Date(row.startsAt);
    const time = (d: Date) =>
      format.dateTime(d, { hour: "2-digit", minute: "2-digit" });
    return `${format.dateTime(start, {
      weekday: "short",
      day: "numeric",
      month: "short",
    })}, ${time(start)}–${time(new Date(row.endsAt))}`;
  };
}

/**
 * One section of the teacher's Substitutions page (design §5.5): date and
 * time linking to the lesson, group, level, room, and who it's for / by.
 */
export async function SubstitutionSection({
  viewer,
  title,
  rows,
  kind,
}: {
  viewer: Viewer;
  title: string;
  rows: SubstitutionRow[];
  kind: "covering" | "coveredForMe";
}) {
  const t = await getTranslations("substitutes.teacher");
  const when = await whenFormatter(viewer);
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby={`section-${kind}`}
    >
      <h2 id={`section-${kind}`} className="text-lg font-semibold">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("sectionEmpty")}</p>
      ) : (
        <ul
          className="flex flex-col gap-2"
          data-testid={`substitutions-${kind}`}
        >
          {rows.map((row) => (
            <li key={row.lessonId}>
              <Card className="py-3">
                <CardContent className="flex flex-col gap-0.5">
                  <Link
                    href={`/teacher/lessons/${row.lessonId}`}
                    className="font-medium tabular-nums underline-offset-4 hover:underline"
                  >
                    {when(row)}
                  </Link>
                  <span>
                    {[row.groupName, row.level, row.room]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <UserRoundCog
                      aria-hidden="true"
                      className="size-4 text-lesson-substitute-text"
                    />
                    {kind === "covering"
                      ? t("for", { teacher: row.teacher.name })
                      : t("by", { substitute: row.substitute?.name ?? "" })}
                  </span>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Dashboard card (design §5.5): only when the teacher covers something soon. */
export async function SubstitutionsCard({
  viewer,
  count,
  next,
}: {
  viewer: Viewer;
  count: number;
  next: SubstitutionRow[];
}) {
  if (count === 0) return null;
  const t = await getTranslations("substitutes.teacher");
  const when = await whenFormatter(viewer);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>
          <h2 className="text-lg font-semibold">{t("cardTitle")}</h2>
        </CardTitle>
        <Link
          href="/teacher/substitutions"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          {t("seeAll")}
        </Link>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p>{t("card", { count })}</p>
        <ul className="flex flex-col gap-1 text-sm">
          {next.map((row) => (
            <li key={row.lessonId}>
              <Link
                href={`/teacher/lessons/${row.lessonId}`}
                className="underline-offset-4 hover:underline"
              >
                <span className="tabular-nums">{when(row)}</span>
                {" · "}
                {row.groupName}
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
