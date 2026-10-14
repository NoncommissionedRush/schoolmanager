import type { Role } from "@/generated/prisma/enums";
import type { Messages } from "@/i18n/messages";

/**
 * Navigation for the full roadmap (docs/design/app-layout.md §4.3). An item is
 * rendered only once its phase has shipped — no "coming soon" links. Bump
 * `SHIPPED_PHASE` (or set `enabled` on a single item) when a feature lands.
 */
export const SHIPPED_PHASE = 0;

export type NavIcon =
  | "layout-dashboard"
  | "house"
  | "calendar-days"
  | "calendar-x"
  | "user-round-cog"
  | "wand-sparkles"
  | "graduation-cap"
  | "presentation"
  | "users-round"
  | "users"
  | "book-open"
  | "signal"
  | "star"
  | "wallet"
  | "chart-column"
  | "settings"
  | "notebook-pen"
  | "clipboard-list";

export type NavLabel = Exclude<keyof Messages["nav"], "section">;
export type NavSection = keyof Messages["nav"]["section"];

export type NavItem = {
  label: NavLabel;
  /** Shorter label for the student bottom tab bar. */
  shortLabel?: NavLabel;
  href: string;
  icon: NavIcon;
  phase: number;
  /** Overrides the phase rule, e.g. to ship a single item early. */
  enabled?: boolean;
  section?: NavSection;
  /** Pinned to the bottom of the sidebar (Settings). */
  pinned?: boolean;
  /** Student bottom tab bar destination. */
  tab?: boolean;
};

const NAVIGATION: Record<Role, NavItem[]> = {
  ADMIN: [
    { label: "dashboard", href: "/admin", icon: "layout-dashboard", phase: 0 },
    {
      label: "timetable",
      href: "/admin/timetable",
      icon: "calendar-days",
      phase: 1,
      enabled: true,
      section: "schedule",
    },
    // Read-only lesson list (lessons.md §7): which lessons miss a log.
    {
      label: "lessonLog",
      href: "/admin/lessons",
      icon: "notebook-pen",
      phase: 2,
      enabled: true,
      section: "schedule",
    },
    {
      label: "absences",
      href: "/admin/absences",
      icon: "calendar-x",
      phase: 3,
      enabled: true,
      section: "schedule",
    },
    {
      label: "substitutions",
      href: "/admin/substitutions",
      icon: "user-round-cog",
      phase: 5,
      section: "schedule",
    },
    {
      label: "autoGenerate",
      href: "/admin/timetable/generate",
      icon: "wand-sparkles",
      phase: 4,
      section: "schedule",
    },
    {
      label: "students",
      href: "/admin/students",
      icon: "graduation-cap",
      phase: 1,
      enabled: true,
      section: "people",
    },
    {
      label: "teachers",
      href: "/admin/teachers",
      icon: "presentation",
      phase: 1,
      enabled: true,
      section: "people",
    },
    {
      label: "parents",
      href: "/admin/parents",
      icon: "users-round",
      phase: 6,
      section: "people",
    },
    {
      label: "courses",
      href: "/admin/groups",
      icon: "book-open",
      phase: 1,
      enabled: true,
      section: "academics",
    },
    {
      label: "levels",
      href: "/admin/levels",
      icon: "signal",
      phase: 1,
      enabled: true,
      section: "academics",
    },
    {
      label: "ratings",
      href: "/admin/ratings",
      icon: "star",
      phase: 5,
      section: "academics",
    },
    {
      label: "payments",
      href: "/admin/payments",
      icon: "wallet",
      phase: 6,
      section: "finance",
    },
    {
      label: "reports",
      href: "/admin/reports",
      icon: "chart-column",
      phase: 6,
      section: "finance",
    },
    {
      label: "settings",
      href: "/admin/settings",
      icon: "settings",
      phase: 1,
      enabled: true,
      pinned: true,
    },
  ],
  TEACHER: [
    {
      label: "dashboard",
      href: "/teacher",
      icon: "layout-dashboard",
      phase: 0,
    },
    {
      label: "myTimetable",
      href: "/teacher/timetable",
      icon: "calendar-days",
      phase: 1,
      enabled: true,
      section: "teaching",
    },
    {
      label: "myGroups",
      href: "/teacher/groups",
      icon: "users",
      phase: 1,
      section: "teaching",
    },
    // Homework lives in the lesson log (lessons.md §5.4): no separate item.
    {
      label: "lessonLog",
      href: "/teacher/lessons",
      icon: "notebook-pen",
      phase: 2,
      enabled: true,
      section: "teaching",
    },
    {
      label: "ratings",
      href: "/teacher/ratings",
      icon: "star",
      phase: 5,
      section: "teaching",
    },
    {
      label: "myAbsences",
      href: "/teacher/absences",
      icon: "calendar-x",
      phase: 3,
      section: "me",
    },
    {
      label: "substitutions",
      href: "/teacher/substitutions",
      icon: "user-round-cog",
      phase: 5,
      section: "me",
    },
  ],
  STUDENT: [
    { label: "home", href: "/student", icon: "house", phase: 0, tab: true },
    {
      label: "timetable",
      href: "/student/timetable",
      icon: "calendar-days",
      phase: 1,
      enabled: true,
      tab: true,
    },
    {
      label: "homework",
      href: "/student/homework",
      icon: "clipboard-list",
      phase: 2,
      enabled: true,
      tab: true,
    },
    {
      label: "absences",
      shortLabel: "absencesShort",
      href: "/student/absences",
      icon: "calendar-x",
      phase: 3,
      enabled: true,
      tab: true,
    },
    { label: "payments", href: "/student/payments", icon: "wallet", phase: 6 },
  ],
};

export function isNavItemEnabled(
  item: NavItem,
  shippedPhase = SHIPPED_PHASE,
): boolean {
  return item.enabled ?? item.phase <= shippedPhase;
}

/** The items a role sees today, in display order. */
export function navigationFor(
  role: Role,
  shippedPhase = SHIPPED_PHASE,
): NavItem[] {
  return NAVIGATION[role].filter((item) =>
    isNavItemEnabled(item, shippedPhase),
  );
}

export type NavGroup = { section: NavSection | null; items: NavItem[] };

/** Groups consecutive items by section; pinned items are returned apart. */
export function groupNavigation(items: NavItem[]): {
  groups: NavGroup[];
  pinned: NavItem[];
} {
  const groups: NavGroup[] = [];
  for (const item of items.filter((i) => !i.pinned)) {
    const section = item.section ?? null;
    const last = groups.at(-1);
    if (last && last.section === section) last.items.push(item);
    else groups.push({ section, items: [item] });
  }
  return { groups, pinned: items.filter((i) => i.pinned) };
}

/**
 * Student bottom tab bar: up to 4 destinations plus "More" once there are
 * more items than tabs. Hidden (empty) while there is only one destination.
 */
export function studentTabs(items: NavItem[]): {
  tabs: NavItem[];
  more: boolean;
} {
  if (items.length < 2) return { tabs: [], more: false };
  const tabs = items.filter((i) => i.tab).slice(0, 4);
  return { tabs, more: items.length > tabs.length };
}

/** Whether `href` is the active nav item for `pathname` (longest match wins). */
export function isActiveHref(
  href: string,
  pathname: string,
  items: NavItem[],
): boolean {
  const matches = items
    .map((i) => i.href)
    .filter((h) => pathname === h || pathname.startsWith(`${h}/`));
  const best = matches.sort((a, b) => b.length - a.length)[0];
  return best === href;
}
