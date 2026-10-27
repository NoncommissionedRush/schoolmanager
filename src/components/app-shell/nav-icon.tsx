import {
  BookOpen,
  CalendarClock,
  CalendarDays,
  CalendarSync,
  CalendarX,
  ChartColumn,
  ClipboardList,
  GraduationCap,
  House,
  LayoutDashboard,
  NotebookPen,
  Presentation,
  Settings,
  Signal,
  Star,
  UserRoundCog,
  Users,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";

import type { NavIcon } from "@/lib/navigation";

const ICONS: Record<NavIcon, LucideIcon> = {
  "layout-dashboard": LayoutDashboard,
  house: House,
  "calendar-days": CalendarDays,
  "calendar-x": CalendarX,
  "calendar-clock": CalendarClock,
  "user-round-cog": UserRoundCog,
  "wand-sparkles": WandSparkles,
  "graduation-cap": GraduationCap,
  presentation: Presentation,
  users: Users,
  "book-open": BookOpen,
  signal: Signal,
  star: Star,
  "chart-column": ChartColumn,
  settings: Settings,
  "notebook-pen": NotebookPen,
  "clipboard-list": ClipboardList,
  "calendar-sync": CalendarSync,
};

export function NavIconGlyph({
  icon,
  className,
}: {
  icon: NavIcon;
  className?: string;
}) {
  const Icon = ICONS[icon];
  return <Icon aria-hidden="true" className={className} />;
}
