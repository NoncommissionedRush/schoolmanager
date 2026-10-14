import { Suspense } from "react";
import { TriangleAlert, User, Users } from "lucide-react";
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
import { lessonTimesLabel } from "@/server/admin/groups/lesson-times";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { adminContext } from "@/server/admin/context";
import { listCourses } from "@/server/admin/courses/service";
import { isFull, pickable } from "@/server/admin/groups/rules";
import { groupFormOptions, listGroups } from "@/server/admin/groups/service";
import { param, parseListParams } from "@/server/admin/list";
import { schoolToday } from "@/server/admin/shared";
import { isUuid } from "@/server/admin/students/filters";

import { CourseRowActions, NewCourseButton } from "./courses-client";
import { GroupRowActions, NewGroupButton } from "./groups-client";
import { TableSkeleton } from "@/components/admin/table-skeleton";

const PATH = "/admin/groups";

async function GroupsPage({ searchParams }: PageProps<"/admin/groups">) {
  const { db, viewer } = await adminContext();
  const t = await getTranslations("groups");
  const tc = await getTranslations("common");
  const tk = await getTranslations("courses");
  const params = await searchParams;
  const list = parseListParams(params);
  const typeParam = param(params, "type");
  const type =
    typeParam === "GROUP" || typeParam === "ONE_ON_ONE" ? typeParam : null;
  const level = isUuid(param(params, "level")) ? param(params, "level") : null;
  const course = isUuid(param(params, "course"))
    ? param(params, "course")
    : null;
  const tab = param(params, "tab") === "courses" ? "courses" : "groups";
  const [{ groups, total, window, activeCount, anyCount }, options, courses] =
    await Promise.all([
      listGroups(
        db,
        { ...list, type, level, course },
        schoolToday(viewer.school.timezone),
      ),
      groupFormOptions(db),
      listCourses(db),
    ]);
  const levelLabel = (l: {
    code: string;
    name: string;
    archivedAt: Date | null;
  }) =>
    l.archivedAt
      ? tc("archivedName", { name: `${l.code} · ${l.name}` })
      : `${l.code} · ${l.name}`;
  const formOptions = {
    levels: options.levels.map((l) => ({
      id: l.id,
      label: levelLabel(l),
      archived: !!l.archivedAt,
    })),
    courses: options.courses,
    students: options.students,
  };
  const activeLevels = pickable(options.levels).map((l) => ({
    id: l.id,
    label: levelLabel(l),
  }));
  const newGroup = <NewGroupButton options={formOptions} />;

  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("description", { count: activeCount })}
        actions={anyCount > 0 && newGroup}
      />
      <Tabs defaultValue={tab}>
        <TabsList>
          <TabsTrigger value="groups">{t("tab.groups")}</TabsTrigger>
          <TabsTrigger value="courses">{t("tab.courses")}</TabsTrigger>
        </TabsList>
        <TabsContent value="groups" className="flex flex-col gap-6 pt-4">
          {anyCount === 0 ? (
            <div className="flex flex-col items-center gap-4">
              <EmptyState
                icon={Users}
                title={t("empty.title")}
                description={t("empty.description")}
              />
              <NewGroupButton options={formOptions} label={t("empty.action")} />
            </div>
          ) : (
            <>
              <ListFilters
                searchLabel={t("search")}
                count={t("caption", { count: total })}
                selects={[
                  {
                    name: "type",
                    label: t("filter.type"),
                    defaultValue: "",
                    options: [
                      { value: "", label: t("filter.all") },
                      { value: "GROUP", label: t("type.GROUP") },
                      { value: "ONE_ON_ONE", label: t("type.ONE_ON_ONE") },
                    ],
                  },
                  {
                    name: "level",
                    label: t("filter.level"),
                    defaultValue: "",
                    options: [
                      { value: "", label: t("filter.all") },
                      ...options.levels.map((l) => ({
                        value: l.id,
                        label: l.archivedAt
                          ? tc("archivedName", { name: l.code })
                          : l.code,
                      })),
                    ],
                  },
                  {
                    name: "course",
                    label: t("filter.course"),
                    defaultValue: "",
                    options: [
                      { value: "", label: t("filter.all") },
                      ...options.courses.map((c) => ({
                        value: c.id,
                        label: c.name,
                      })),
                    ],
                  },
                ]}
              />
              {groups.length === 0 ? (
                <NoResults
                  entities={t("entities")}
                  archived={
                    list.status === "archived" &&
                    !list.q &&
                    !type &&
                    !level &&
                    !course
                  }
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
                          <TableHead>{t("col.type")}</TableHead>
                          <TableHead>{t("col.level")}</TableHead>
                          <TableHead>{t("col.course")}</TableHead>
                          <TableHead>{t("col.members")}</TableHead>
                          <TableHead>{t("lessonTimes.column")}</TableHead>
                          <TableHead>{t("col.teachers")}</TableHead>
                          <TableHead>
                            <span className="sr-only">{tc("edit")}</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {groups.map((group) => (
                          <TableRow key={group.id}>
                            <TableCell className="font-medium">
                              <span className="flex items-center gap-2">
                                <Link
                                  href={`${PATH}/${group.id}`}
                                  className="max-w-56 truncate underline-offset-4 hover:underline"
                                  title={group.name}
                                >
                                  {group.name}
                                </Link>
                                {group.deletedAt && <ArchivedBadge />}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="flex items-center gap-1.5">
                                {group.type === "GROUP" ? (
                                  <Users
                                    aria-hidden="true"
                                    className="size-4"
                                  />
                                ) : (
                                  <User aria-hidden="true" className="size-4" />
                                )}
                                {t(`type.${group.type}`)}
                              </span>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">
                                {group.level.archivedAt
                                  ? tc("archivedName", {
                                      name: group.level.code,
                                    })
                                  : group.level.code}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {group.course?.name ?? tc("none")}
                            </TableCell>
                            <TableCell>
                              <span className="flex items-center gap-2 tabular-nums">
                                {t("membersCount", {
                                  count: group.members,
                                  capacity: group.capacity,
                                })}
                                {isFull(group.capacity, group.members) && (
                                  <Badge variant="secondary">{t("full")}</Badge>
                                )}
                                {group.type === "ONE_ON_ONE" &&
                                  group.members === 0 && (
                                    <Badge variant="destructive">
                                      <TriangleAlert aria-hidden="true" />
                                      {t("noStudent")}
                                    </Badge>
                                  )}
                              </span>
                            </TableCell>
                            <TableCell className="tabular-nums">
                              {lessonTimesLabel(group.lessonTimes, (day) =>
                                tc(`weekdayShort.${day}` as "weekdayShort.1"),
                              ) || (
                                <span className="text-muted-foreground">
                                  {t("lessonTimes.none")}
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              {group.teachers.join(", ") || tc("none")}
                            </TableCell>
                            <TableCell className="text-right">
                              <GroupRowActions
                                group={{
                                  id: group.id,
                                  name: group.name,
                                  type: group.type,
                                  levelId: group.levelId,
                                  courseId: group.courseId,
                                  capacity: group.capacity,
                                  updatedAt: group.updatedAt.toISOString(),
                                  lessons: group.lessons,
                                  members: group.members,
                                  archived: !!group.deletedAt,
                                }}
                                options={formOptions}
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
                      listHref(PATH, {
                        q: list.q,
                        status: list.status,
                        type,
                        level,
                        course,
                        page,
                      })
                    }
                  />
                </>
              )}
            </>
          )}
        </TabsContent>
        <TabsContent value="courses" className="flex flex-col gap-4 pt-4">
          <div>
            <NewCourseButton levels={activeLevels} />
          </div>
          {courses.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tk("empty")}</p>
          ) : (
            <TableCard>
              <Table>
                <TableCaption className="sr-only">
                  {tk("caption", { count: courses.length })}
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tk("col.name")}</TableHead>
                    <TableHead>{tk("col.level")}</TableHead>
                    <TableHead>{tk("col.groups")}</TableHead>
                    <TableHead>
                      <span className="sr-only">{tc("edit")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {courses.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">
                        <span className="flex flex-col">
                          {c.name}
                          {c.description && (
                            <span className="text-xs font-normal text-muted-foreground">
                              {c.description}
                            </span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {c.level.archivedAt
                            ? tc("archivedName", { name: c.level.code })
                            : c.level.code}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {c.groups > 0 ? (
                          <Link
                            href={listHref(PATH, { course: c.id })}
                            className="underline-offset-4 hover:underline"
                          >
                            {c.groups}
                          </Link>
                        ) : (
                          c.groups
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <CourseRowActions
                          course={{
                            id: c.id,
                            name: c.name,
                            levelId: c.levelId,
                            description: c.description,
                            groups: c.groups,
                          }}
                          levels={pickable(options.levels, c.levelId).map(
                            (l) => ({ id: l.id, label: levelLabel(l) }),
                          )}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableCard>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Own Suspense boundary: client navigations between admin pages re-render
// below the shared layout, so the shell's boundary doesn't cover them.
export default function Page(props: Parameters<typeof GroupsPage>[0]) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <GroupsPage {...props} />
    </Suspense>
  );
}
