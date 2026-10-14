import { redirect } from "next/navigation";

/**
 * Settings index: the sub-nav lives in the layout; open the first section.
 * No data is read here — the target page checks the role.
 */
export default function SettingsPage() {
  redirect("/admin/settings/school");
}
