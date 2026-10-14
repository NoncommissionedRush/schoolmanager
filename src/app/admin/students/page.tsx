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
import { groupPickerOptions } from "@/server/admin/groups/service";
import { pickable } from "@/server/admin/groups/rules";
import { schoolToday } from "@/server/admin/shared";
import { NONE, parseStudentFilters } from "@/server/admin/students/filters";
import {
  listStudents,
  studentFilterOptions,
} from "@/server/admin/students/service";
import { toIsoDate } from "@/server/scheduling";

import { NewStudentButton, StudentRowActions } from "./students-client";
import { TableSkeleton } from "@/components/admin/table-skeleton";

const PATH = "/admin/students";

async function StudentsPage({ searchParams }: PageProps<"/admin/students">) {
  const { db, viewer } = await adminContext();
  const t = await getTranslations("students");
  const tc = await getTranslations("common");
  const filters = parseStudentFilters(await searchParams);
  const [{ students, total, window, activeCount, anyCount }, options, groups] =
    await Promise.all([
      listStudents(db, filters),
      studentFilterOptions(db),
      groupPickerOptions(db),
    ]);
  const today = toIsoDate(schoolToday(viewer.school.timezone));
  const levels = pickable(options.levels).map((level) => ({
    id: level.id,
    label: `${level.code} · ${level.name}`,
  }));
  const newStudent = <NewStudentButton levels={levels} groups={groups} />;
  const filtered = !!(filters.q || filters.level || filters.group);

  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("count", { count: activeCount })}
        actions={anyCount > 0 && newStudent}
      />
      {anyCount === 0 ? (
        <div className="flex flex-col items-center gap-4">
          <EmptyState
            icon={GraduationCap}
            title={t("empty.title")}
            description={t("empty.description")}
          />
          <NewStudentButton
            levels={levels}
            groups={groups}
            label={t("empty.action")}
          />
        </div>
      ) : (
        <>
          <ListFilters
            searchLabel={t("search")}
            count={t("caption", { count: total })}
            selects={[
              {
                name: "level",
                label: t("filter.level"),
                defaultValue: "",
                options: [
                  { value: "", label: t("filter.any") },
                  { value: NONE, label: t("filter.noLevel") },
                  ...options.levels.map((level) => ({
                    value: level.id,
                    label: level.archivedAt
                      ? tc("archivedName", { name: level.code })
                      : level.code,
                  })),
                ],
              },
              {
                name: "group",
                label: t("filter.group"),
                defaultValue: "",
                options: [
                  { value: "", label: t("filter.any") },
                  { value: NONE, label: t("filter.noGroup") },
                  ...options.groups.map((group) => ({
                    value: group.id,
                    label: group.deletedAt
                      ? tc("archivedName", { name: group.name })
                      : group.name,
                  })),
                ],
              },
            ]}
          />
          {students.length === 0 ? (
            <NoResults
              entities={t("entities")}
              archived={filters.status === "archived" && !filtered}
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
                      <TableHead>{t("col.level")}</TableHead>
                      <TableHead>{t("col.groups")}</TableHead>
                      <TableHead>{t("col.phone")}</TableHead>
                      <TableHead>
                        <span className="sr-only">{tc("edit")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {students.map((student) => {
                      const groupNames = student.groups
                        .map((group) => group.name)
                        .join(", ");
                      return (
                        <TableRow key={student.id}>
                          <TableCell className="font-medium">
                            <span className="flex items-center gap-2">
                              <Link
                                href={`${PATH}/${student.id}`}
                                className="max-w-56 truncate underline-offset-4 hover:underline"
                                title={student.name}
                              >
                                {student.name}
                              </Link>
                              {student.archived && <ArchivedBadge />}
                            </span>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {student.email}
                          </TableCell>
                          <TableCell>
                            {student.level ? (
                              <Badge variant="outline">
                                {student.level.code}
                              </Badge>
                            ) : (
                              tc("none")
                            )}
                          </TableCell>
                          <TableCell>
                            {groupNames ? (
                              <span
                                className="block max-w-64 truncate"
                                title={groupNames}
                              >
                                {groupNames}
                              </span>
                            ) : (
                              tc("none")
                            )}
                          </TableCell>
                          <TableCell>{student.phone ?? tc("none")}</TableCell>
                          <TableCell className="text-right">
                            <StudentRowActions
                              student={{
                                id: student.id,
                                userId: student.userId,
                                name: student.name,
                                levelId: student.levelId,
                                archived: student.archived,
                                groupIds: student.groups.map((g) => g.id),
                                groupNames: student.groups.map((g) => g.name),
                              }}
                              groups={groups}
                              today={today}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableCard>
              <Pagination
                window={window}
                total={total}
                hrefFor={(page) =>
                  listHref(PATH, {
                    q: filters.q,
                    status: filters.status,
                    level: filters.level,
                    group: filters.group,
                    page,
                  })
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
export default function Page(props: Parameters<typeof StudentsPage>[0]) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <StudentsPage {...props} />
    </Suspense>
  );
}
