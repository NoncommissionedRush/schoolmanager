import { AppShell } from "@/components/app-shell/app-shell";

export default function TeacherLayout({ children }: LayoutProps<"/teacher">) {
  return <AppShell role="TEACHER">{children}</AppShell>;
}
