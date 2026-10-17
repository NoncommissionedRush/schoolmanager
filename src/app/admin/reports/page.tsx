import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/admin/list";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { adminContext } from "@/server/admin/context";

/** _Reports_ (reports.md §4.0): one card per report. Admins only. */
export default async function ReportsPage() {
  await adminContext();
  const t = await getTranslations("reports");
  const reports = [
    {
      href: "/admin/reports/attendance",
      title: t("attendance.title"),
      description: t("attendance.description"),
    },
    {
      href: "/admin/reports/teacher-hours",
      title: t("hours.title"),
      description: t("hours.description"),
    },
  ];
  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="grid gap-4 md:grid-cols-2">
        {reports.map((report) => (
          <Card key={report.href}>
            <CardHeader>
              <CardTitle>
                <h2>{report.title}</h2>
              </CardTitle>
              <CardDescription>{report.description}</CardDescription>
            </CardHeader>
            <CardFooter>
              <Link
                href={report.href}
                className={buttonVariants({ variant: "outline" })}
                aria-label={t("openLabel", { report: report.title })}
              >
                {t("open")}
              </Link>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}
