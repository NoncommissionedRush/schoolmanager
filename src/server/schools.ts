/**
 * Derives a URL-safe slug from a school name, e.g. "Lingua Café Bratislava"
 * -> "lingua-cafe-bratislava".
 */
export function toSchoolSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
