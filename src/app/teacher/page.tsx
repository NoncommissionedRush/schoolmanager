import { CalendarDays } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { DashboardHeader } from "@/components/dashboard-header";
import { EmptyState } from "@/components/empty-state";
import { TodoCard } from "@/components/lessons/todo-card";
import { teacherContext } from "@/server/lessons/context";
import { loadTeacherTodo, teacherHasLessons } from "@/server/lessons/teacher";

export default async function TeacherDashboardPage() {
  const { viewer, db, teacherId } = await teacherContext();
  const t = await getTranslations("dashboard.teacher");
  const [hasLessons, todo] = await Promise.all([
    teacherHasLessons(db, teacherId),
    loadTeacherTodo(db, teacherId, new Date(), viewer.school.timezone),
  ]);
  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <DashboardHeader viewer={viewer} />
      {hasLessons ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <TodoCard items={todo} />
        </div>
      ) : (
        <EmptyState
          icon={CalendarDays}
          title={t("empty.title")}
          description={t("empty.description")}
        />
      )}
    </div>
  );
}
