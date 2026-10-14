import type { Locale } from "./config";
import type enGB from "../../messages/en-GB";

export type Messages = typeof enGB;

const catalogs: Record<Locale, () => Promise<{ default: Messages }>> = {
  "en-GB": () => import("../../messages/en-GB"),
};

export async function loadMessages(locale: Locale): Promise<Messages> {
  return (await catalogs[locale]()).default;
}
