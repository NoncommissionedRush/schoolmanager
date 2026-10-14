"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import type { Role } from "@/generated/prisma/enums";
import {
  groupNavigation,
  isActiveHref,
  navigationFor,
  type NavItem,
} from "@/lib/navigation";

import { NavIconGlyph } from "./nav-icon";

export function AppSidebar({ role }: { role: Role }) {
  const t = useTranslations();
  const items = navigationFor(role);
  const { groups, pinned } = groupNavigation(items);

  return (
    <Sidebar
      collapsible="icon"
      mobileTitle={t("nav.label")}
      mobileCloseLabel={t("common.close")}
      className="top-(--header-height) h-[calc(100svh-var(--header-height))]!"
    >
      <nav aria-label={t("nav.label")} className="contents">
        <SidebarContent>
          {groups.map((group) => (
            <SidebarGroup key={group.section ?? "main"}>
              {group.section && (
                <SidebarGroupLabel>
                  {t(`nav.section.${group.section}`)}
                </SidebarGroupLabel>
              )}
              <SidebarGroupContent>
                <NavMenu items={group.items} all={items} />
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        {pinned.length > 0 && (
          <SidebarFooter>
            <NavMenu items={pinned} all={items} />
          </SidebarFooter>
        )}
      </nav>
    </Sidebar>
  );
}

function NavMenu({ items, all }: { items: NavItem[]; all: NavItem[] }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarMenu>
      {items.map((item) => {
        const active = isActiveHref(item.href, pathname, all);
        return (
          <SidebarMenuItem key={item.href}>
            <SidebarMenuButton
              isActive={active}
              tooltip={t(item.label)}
              render={
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => isMobile && setOpenMobile(false)}
                />
              }
            >
              <NavIconGlyph icon={item.icon} />
              <span>{t(item.label)}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
