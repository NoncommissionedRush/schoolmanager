"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { isActiveHref, navigationFor, studentTabs } from "@/lib/navigation";

import { NavIconGlyph } from "./nav-icon";

const tabClass =
  "flex min-h-11 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium text-muted-foreground aria-[current=page]:text-primary";

/** Mobile-only bottom tab bar for students; hidden while there is one destination. */
export function StudentTabBar() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const items = navigationFor("STUDENT");
  const { tabs, more } = studentTabs(items);
  if (tabs.length === 0) return null;

  return (
    <nav
      aria-label={t("tabsLabel")}
      className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {tabs.map((item) => {
        const active = isActiveHref(item.href, pathname, items);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(tabClass, "h-16")}
          >
            <NavIconGlyph icon={item.icon} className="size-5" />
            {t(item.shortLabel ?? item.label)}
          </Link>
        );
      })}
      {more && (
        <button
          type="button"
          className={cn(tabClass, "h-16")}
          onClick={() => setOpenMobile(true)}
        >
          <Menu aria-hidden="true" className="size-5" />
          {t("more")}
        </button>
      )}
    </nav>
  );
}
