import { getTranslations } from "next-intl/server";

import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Viewer } from "@/server/auth/access";
import { firstName, initials } from "@/server/dashboard/greeting";

import { SchoolTile } from "./school-tile";
import { UserMenu } from "./user-menu";

export async function AppHeader({ viewer }: { viewer: Viewer }) {
  const t = await getTranslations("nav");
  return (
    <header className="sticky top-0 z-50 flex h-(--header-height) w-full shrink-0 items-center gap-2 border-b bg-background px-2 md:px-4">
      <SidebarTrigger label={t("toggleSidebar")} className="size-9" />
      <SchoolTile name={viewer.school.name} />
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="min-w-0 truncate text-sm font-semibold"
              data-testid="school-name"
            />
          }
        >
          {viewer.school.name}
        </TooltipTrigger>
        <TooltipContent>{viewer.school.name}</TooltipContent>
      </Tooltip>
      <div className="ml-auto">
        <UserMenu
          name={viewer.name}
          firstName={firstName(viewer.name)}
          initials={initials(viewer.name)}
          email={viewer.email}
          role={viewer.role}
        />
      </div>
    </header>
  );
}
