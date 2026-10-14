export type PartOfDay = "morning" | "afternoon" | "evening";

/** Hour of `now` in `timeZone` (0–23). */
function hourIn(now: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone,
  }).format(now);
  return Number(hour);
}

/** Morning before 12:00, afternoon before 18:00, evening otherwise — in the school's time zone. */
export function partOfDay(now: Date, timeZone: string): PartOfDay {
  const hour = hourIn(now, timeZone);
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}

/** First word of a display name, for greetings ("Jana Nováková" → "Jana"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** Up to two initials, e.g. "Demo Language School" → "DL". */
export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toLocaleUpperCase())
    .join("");
}
