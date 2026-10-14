import type { Locale } from "./config";
import type { formats } from "./formats";
import type { Messages } from "./messages";

// Makes translation keys, locales and named formats type-checked.
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
    Formats: typeof formats;
  }
}
