import { Suspense } from "react";
import { GraduationCap } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { ListFilters } from "@/components/admin/list-filters";
import {
  ArchivedBadge,
  listHref,
  NoResults,
  PageHeader,
  Pagination,
  TableCard,
} from "@/components/admin/list";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminContext } from "@/server/admin/context";
import { parseListParams } from "@/server/admin/list";
import { schoolToday } from "@/server/admin/shared";
import { listTeachers } from "@/server/admin/teachers/service";

import {
  ColorDot,
  NewTeacherButton,
  TeacherRowActions,
} from "./teachers-client";
import { TableSkeleton } from "@/components/admin/table-skeleton";

const PATH = "/admin/teachers";

async function TeachersPage({ searchParams }: PageProps<"/admin/teachers">) {
  const { db, viewer } = await adminContext();
  const t = await getTranslations("teachers");
  const tc = await getTranslations("common");
  const list = parseListParams(await searchParams);
  const { teachers, total, window, activeCount, anyCount, nextColor } =
    await listTeachers(db, list, schoolToday(viewer.school.timezone));

  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("count", { count: activeCount })}
        actions={anyCount > 0 && <NewTeacherButton nextColor={nextColor} />}
      />
      {anyCount === 0 ? (
        <div className="flex flex-col items-center gap-4">
          <EmptyState
            icon={GraduationCap}
            title={t("empty.title")}
            description={t("empty.description")}
          />
          <NewTeacherButton label={t("empty.action")} nextColor={nextColor} />
        </div>
      ) : (
        <>
          <ListFilters
            searchLabel={t("search")}
            count={t("caption", { count: total })}
          />
          {teachers.length === 0 ? (
            <NoResults
              entities={t("entities")}
              archived={list.status === "archived" && !list.q}
              clearHref={PATH}
            />
          ) : (
            <>
              <TableCard>
                <Table>
                  <TableCaption className="sr-only">
                    {t("caption", { count: total })}
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("col.name")}</TableHead>
                      <TableHead>{t("col.email")}</TableHead>
                      <TableHead>{t("col.groups")}</TableHead>
                      <TableHead>{t("col.lessonsPerWeek")}</TableHead>
                      {list.status === "all" && (
                        <TableHead>{t("col.status")}</TableHead>
                      )}
                      <TableHead>
                        <span className="sr-only">{tc("edit")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {teachers.map((teacher) => (
                      <TableRow key={teacher.id}>
                        <TableCell className="max-w-64 font-medium">
                          <span className="flex items-center gap-2">
                            <ColorDot color={teacher.color} />
                            <Link
                              href={`${PATH}/${teacher.id}`}
                              title={teacher.name}
                              className="truncate underline-offset-4 hover:underline"
                            >
                              {teacher.name}
                            </Link>
                            {teacher.archived && list.status !== "all" && (
                              <ArchivedBadge />
                            )}
                          </span>
                        </TableCell>
                        <TableCell>{teacher.email}</TableCell>
                        <TableCell>{teacher.groups}</TableCell>
                        <TableCell>{teacher.lessonsPerWeek}</TableCell>
                        {list.status === "all" && (
                          <TableCell>
                            <Badge
                              variant={
                                teacher.archived ? "secondary" : "outline"
                              }
                            >
                              {teacher.archived
                                ? tc("status.archived")
                                : tc("status.active")}
                            </Badge>
                          </TableCell>
                        )}
                        <TableCell className="text-right">
                          <TeacherRowActions
                            teacher={{
                              id: teacher.id,
                              userId: teacher.userId,
                              name: teacher.name,
                              archived: teacher.archived,
                            }}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableCard>
              <Pagination
                window={window}
                total={total}
                hrefFor={(page) =>
                  listHref(PATH, { q: list.q, status: list.status, page })
                }
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

// Own Suspense boundary: client navigations between admin pages re-render
// below the shared layout, so the shell's boundary doesn't cover them.
export default function Page(props: Parameters<typeof TeachersPage>[0]) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <TeachersPage {...props} />
    </Suspense>
  );
}
