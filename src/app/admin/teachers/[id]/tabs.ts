/** Teacher detail tabs (§6.3), addressable as `?tab=`. */
export const TEACHER_TABS = ["profile", "availability", "groups"] as const;
export type TeacherTab = (typeof TEACHER_TABS)[number];

export function parseTeacherTab(value: string): TeacherTab {
  return (TEACHER_TABS as readonly string[]).includes(value)
    ? (value as TeacherTab)
    : "profile";
}
