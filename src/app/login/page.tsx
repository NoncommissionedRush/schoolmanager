import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { connection } from "next/server";
import { Suspense } from "react";

import { SchoolTile } from "@/components/app-shell/school-tile";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { db } from "@/lib/db";
import { safeCallbackPath } from "@/server/auth/roles";
import { DEMO_LOGINS, DEMO_PASSWORD } from "../../../prisma/seed/data";

import { LoginForm } from "./login-form";

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main
      id="content"
      className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-4"
    >
      <Suspense fallback={<LoginSkeleton />}>
        <Login searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Login({
  searchParams,
}: {
  searchParams: PageProps<"/login">["searchParams"];
}) {
  await connection();
  const params = await searchParams;
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  const t = await getTranslations("auth.login");
  const tc = await getTranslations("common");

  // v1 runs one school per deployment; choosing a school at login is P6.
  const school = await db.school.findFirst({
    orderBy: { createdAt: "asc" },
    select: { name: true },
  });
  const schoolName = school?.name ?? tc("appName");

  return (
    <>
      <div className="flex flex-col items-center gap-3 text-center">
        <SchoolTile name={schoolName} className="size-12 text-base" />
        <p className="text-3xl font-semibold">{schoolName}</p>
      </div>
      <Card className="w-full max-w-sm rounded-xl">
        <CardContent className="flex flex-col gap-6 p-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("subtitle", { schoolName })}
            </p>
          </div>
          <NextIntlClientProvider>
            <LoginForm
              callbackUrl={safeCallbackPath(first(params.callbackUrl))}
              sessionExpired={first(params.reason) === "expired"}
            />
          </NextIntlClientProvider>
        </CardContent>
      </Card>
      {process.env.NODE_ENV === "development" && (
        <p className="max-w-sm text-center text-xs text-muted-foreground">
          {t("demoHint", { ...DEMO_LOGINS, password: DEMO_PASSWORD })}
        </p>
      )}
    </>
  );
}

function LoginSkeleton() {
  return (
    <>
      <Skeleton className="size-12" />
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-80 w-full max-w-sm rounded-xl" />
    </>
  );
}
