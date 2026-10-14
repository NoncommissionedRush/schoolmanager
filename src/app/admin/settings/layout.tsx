import { getTranslations } from "next-intl/server";

import { SettingsNav } from "./settings-nav";

/** Settings sub-navigation (§3): left nav on desktop, list on mobile. */
export default async function SettingsLayout({
  children,
}: LayoutProps<"/admin/settings">) {
  const t = await getTranslations("settings");
  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6 md:flex-row">
      <nav aria-label={t("title")} className="md:w-52 md:shrink-0">
        <SettingsNav
          items={[
            { href: "/admin/settings/school", label: t("nav.school") },
            { href: "/admin/settings/terms", label: t("nav.terms") },
            { href: "/admin/settings/rooms", label: t("nav.rooms") },
            { href: "/admin/settings/admins", label: t("nav.admins") },
          ]}
        />
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
