import { getRequestConfig } from "next-intl/server";
import { defaultLocale, defaultTimeZone } from "./config";
import { formats } from "./formats";
import { loadMessages } from "./messages";

// Single-locale setup without locale-prefixed routes. When more languages are
// added, resolve the locale here (user/school setting or a cookie).
export default getRequestConfig(async () => {
  const locale = defaultLocale;
  return {
    locale,
    messages: await loadMessages(locale),
    timeZone: defaultTimeZone,
    formats,
  };
});
