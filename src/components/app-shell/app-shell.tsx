import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { Suspense, type ReactNode } from "react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Role } from "@/generated/prisma/enums";
import { requireRole } from "@/server/auth/session";

import { AppHeader } from "./app-header";
import { AppSidebar } from "./app-sidebar";
import { StudentTabBar } from "./student-tab-bar";

/**
 * Signed-in layout for one role area (docs/design/app-layout.md §4): sticky
 * header, collapsible sidebar (sheet on mobile), student bottom tabs. The
 * role is checked against the database before anything inside renders.
 */
export function AppShell({
  role,
  children,
}: {
  role: Role;
  children: ReactNode;
}) {
  return (
    <>
      <SkipLink />
      <Suspense fallback={<ShellSkeleton />}>
        <AuthorizedShell role={role}>{children}</AuthorizedShell>
      </Suspense>
    </>
  );
}

async function SkipLink() {
  const t = await getTranslations("common");
  return (
    <a
      href="#content"
      className="sr-only z-[60] rounded-md bg-background px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-2 focus:ring-ring"
    >
      {t("skipToContent")}
    </a>
  );
}

async function AuthorizedShell({
  role,
  children,
}: {
  role: Role;
  children: ReactNode;
}) {
  const viewer = await requireRole(role);
  const sidebarState = (await cookies()).get("sidebar_state")?.value;

  return (
    <NextIntlClientProvider timeZone={viewer.school.timezone}>
      <TooltipProvider>
        <SidebarProvider
          defaultOpen={sidebarState !== "false"}
          className="flex-col [--header-height:3.5rem]"
        >
          <AppHeader viewer={viewer} />
          <div className="flex flex-1">
            <AppSidebar role={viewer.role} />
            <SidebarInset className="bg-muted">
              <main
                id="content"
                tabIndex={-1}
                className={
                  role === "STUDENT"
                    ? "flex-1 p-4 pb-24 outline-none md:p-6"
                    : "flex-1 p-4 outline-none md:p-6"
                }
              >
                {children}
              </main>
            </SidebarInset>
          </div>
          {role === "STUDENT" && <StudentTabBar />}
          <Toaster position="bottom-right" />
        </SidebarProvider>
      </TooltipProvider>
    </NextIntlClientProvider>
  );
}

function ShellSkeleton() {
  return (
    <div className="flex min-h-svh flex-col">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <Skeleton className="size-8" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="ml-auto size-8 rounded-full" />
      </div>
      <div className="flex flex-1">
        <div className="hidden w-64 flex-col gap-2 border-r p-4 md:flex">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
        <div className="flex flex-1 flex-col gap-6 bg-muted p-6">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-40 w-full max-w-3xl" />
        </div>
      </div>
    </div>
  );
}
