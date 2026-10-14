import "server-only";

import { createFormatter } from "next-intl";
import { getLocale } from "next-intl/server";

import { formats } from "./formats";

/**
 * Server-side formatter in the school's time zone. The request config
 * (`request.ts`) only knows the default time zone because it must stay
 * static for public pages; signed-in pages format with this instead, and
 * client components get the school's zone from the app shell's provider.
 */
export async function getSchoolFormatter(school: { timezone: string }) {
  return createFormatter({
    locale: await getLocale(),
    timeZone: school.timezone,
    formats,
  });
}
