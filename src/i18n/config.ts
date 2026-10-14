/**
 * Supported UI locales. v1 ships British English only (day-month dates,
 * 24-hour clock); add a locale here together with its `messages/<locale>/`
 * catalog — see docs/architecture/i18n.md.
 */
export const locales = ["en-GB"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en-GB";

/**
 * Times are shown in the school's time zone (`School.timezone`), not the
 * browser's. This default only applies outside the signed-in app shell
 * (login, error pages); see src/i18n/school-format.ts.
 */
export const defaultTimeZone = "Europe/Bratislava";

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}
