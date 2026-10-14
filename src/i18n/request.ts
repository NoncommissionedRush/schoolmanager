import { getRequestConfig } from "next-intl/server";
import { defaultLocale, defaultTimeZone } from "./config";
import { formats } from "./formats";
import { loadMessages } from "./messages";

// Single-locale setup without locale-prefixed routes. When more languages are
// added, resolve the locale here (user/school setting or a cookie).
//
// This config must not read the session: the root layout and static pages
// call it outside any <Suspense>, which Cache Components rejects. Signed-in
// pages use the school's time zone via the app shell's provider (client) and
// `getSchoolFormatter` (server) instead.
export default getRequestConfig(async () => {
  const locale = defaultLocale;
  return {
    locale,
    messages: await loadMessages(locale),
    timeZone: defaultTimeZone,
    formats,
  };
});
