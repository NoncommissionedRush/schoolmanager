import { Suspense } from "react";
import { CircleCheck, Circle, School } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { DashboardHeader } from "@/components/dashboard-header";
import { EmptyState } from "@/components/empty-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { adminContext } from "@/server/admin/context";
import { loadSetupCounts, setupChecklist } from "@/server/admin/setup";
import { DashboardSkeleton } from "@/components/dashboard-skeleton";

async function AdminDashboardPage() {
  // Layouts don't guard pages on their own; every page checks the role.
  const { db, viewer } = await adminContext();
  const t = await getTranslations("dashboard.admin");
  const checklist = setupChecklist(await loadSetupCounts(db));
  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <DashboardHeader viewer={viewer} />
      {checklist.complete ? (
        <EmptyState
          icon={School}
          title={t("empty.title")}
          description={t("empty.description")}
        />
      ) : (
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>
              <h2>{t("setup.title")}</h2>
            </CardTitle>
            <CardDescription>
              {t("setup.progress", {
                done: checklist.done,
                total: checklist.total,
              })}
            </CardDescription>
            <div
              role="progressbar"
              aria-label={t("setup.title")}
              aria-valuemin={0}
              aria-valuemax={checklist.total}
              aria-valuenow={checklist.done}
              className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary"
                style={{
                  width: `${(checklist.done / checklist.total) * 100}%`,
                }}
              />
            </div>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col divide-y">
              {checklist.steps.map((step) => (
                <li key={step.key} className="flex items-center gap-3 py-2">
                  {step.done ? (
                    <CircleCheck
                      aria-hidden="true"
                      className="size-5 shrink-0 text-success"
                    />
                  ) : (
                    <Circle
                      aria-hidden="true"
                      className="size-5 shrink-0 text-muted-foreground"
                    />
                  )}
                  <Link
                    href={step.href}
                    className="text-sm underline-offset-4 hover:underline"
                  >
                    {t(`setup.${step.key}`)}
                  </Link>
                  {step.done && (
                    <span className="sr-only">{t("setup.done")}</span>
                  )}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Own Suspense boundary: client navigations between admin pages re-render
// below the shared layout, so the shell's boundary doesn't cover them.
export default function Page() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <AdminDashboardPage />
    </Suspense>
  );
}
