import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { ArchivedBadge, PageHeader, TableCard } from "@/components/admin/list";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
import { pickable } from "@/server/admin/groups/rules";
import { groupPickerOptions } from "@/server/admin/groups/service";
import { param } from "@/server/admin/list";
import { lastPasswordChange } from "@/server/admin/people/service";
import { schoolToday } from "@/server/admin/shared";
import {
  getStudent,
  studentFilterOptions,
} from "@/server/admin/students/service";
import { isUuid } from "@/server/admin/students/filters";
import { toIsoDate } from "@/server/scheduling";

import {
  AddToGroupButton,
  RemoveMembershipButton,
  StudentHeaderActions,
  StudentProfileForm,
} from "./student-detail-client";
import { TableSkeleton } from "@/components/admin/table-skeleton";

const DATE = {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
} as const;

async function StudentPage({
  params,
  searchParams,
}: PageProps<"/admin/students/[id]">) {
  const scope = await adminContext();
  const { db, viewer } = scope;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const todayDate = schoolToday(viewer.school.timezone);
  const student = await getStudent(db, id, todayDate);
  if (!student) notFound();
  const t = await getTranslations("students");
  const tc = await getTranslations("common");
  const tg = await getTranslations("groups");
  const tp = await getTranslations("people");
  const format = await getFormatter();
  const tab =
    param(await searchParams, "tab") === "groups" ? "groups" : "profile";
  const today = toIsoDate(todayDate);
  const [options, groups, passwordSetAt] = await Promise.all([
    studentFilterOptions(db),
    groupPickerOptions(db),
    lastPasswordChange(scope, student.userId),
  ]);
  const levels = pickable(options.levels, student.levelId).map((level) => ({
    id: level.id,
    label: level.archivedAt
      ? tc("archivedName", { name: `${level.code} · ${level.name}` })
      : `${level.code} · ${level.name}`,
  }));
  const date = (value: Date) => format.dateTime(value, DATE);
  const ref = {
    id: student.id,
    userId: student.userId,
    name: student.name,
    levelId: student.levelId,
    archived: student.archived,
    groupIds: student.current.map((m) => m.groupId),
    groupNames: student.current.map((m) => m.name),
  };

  return (
    <div className="mx-auto flex max-w-screen-xl flex-col gap-6">
      <PageHeader
        back={{ href: "/admin/students", label: t("back") }}
        title={student.name}
        badges={
          <>
            {student.level && (
              <Badge variant="outline">
                {student.level.archivedAt
                  ? tc("archivedName", { name: student.level.code })
                  : student.level.code}
              </Badge>
            )}
            {student.archived && <ArchivedBadge />}
          </>
        }
        description={student.email}
        actions={<StudentHeaderActions student={ref} />}
      />
      <Tabs defaultValue={tab}>
        <TabsList>
          <TabsTrigger value="profile">{t("tab.profile")}</TabsTrigger>
          <TabsTrigger value="groups">{t("tab.groups")}</TabsTrigger>
        </TabsList>
        <TabsContent value="profile" className="flex flex-col gap-6 pt-4">
          <Card className="max-w-2xl p-6">
            <StudentProfileForm
              student={{
                id: student.id,
                name: student.name,
                email: student.email,
                levelId: student.levelId,
                phone: student.phone,
                updatedAt: student.updatedAt.toISOString(),
              }}
              levels={levels}
              currentGroups={student.current.map((m) => ({
                name: m.name,
                levelId: m.levelId,
                levelCode: m.levelCode,
              }))}
            />
          </Card>
          <Card className="max-w-2xl gap-2 p-6">
            <h2 className="font-medium">{tp("signIn")}</h2>
            <p className="text-sm text-muted-foreground">
              {passwordSetAt
                ? tp("lastPasswordChange", {
                    date: format.dateTime(passwordSetAt, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    }),
                  })
                : tp("neverSet")}
            </p>
          </Card>
        </TabsContent>
        <TabsContent value="groups" className="flex flex-col gap-6 pt-4">
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-medium">{t("groups.current")}</h2>
              {!student.archived && (
                <AddToGroupButton student={ref} groups={groups} today={today} />
              )}
            </div>
            {student.current.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("groups.noneCurrent", { name: student.name })}
              </p>
            ) : (
              <TableCard>
                <Table>
                  <TableCaption className="sr-only">
                    {t("groups.current")}
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("groups.group")}</TableHead>
                      <TableHead>{t("groups.type")}</TableHead>
                      <TableHead>{t("groups.level")}</TableHead>
                      <TableHead>{t("groups.teachers")}</TableHead>
                      <TableHead>{t("groups.joined")}</TableHead>
                      <TableHead>
                        <span className="sr-only">{t("groups.remove")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {student.current.map((membership) => (
                      <TableRow key={membership.id}>
                        <TableCell className="font-medium">
                          <span className="flex items-center gap-2">
                            <Link
                              href={`/admin/groups/${membership.groupId}`}
                              className="underline-offset-4 hover:underline"
                            >
                              {membership.name}
                            </Link>
                            {membership.archived && <ArchivedBadge />}
                          </span>
                        </TableCell>
                        <TableCell>{tg(`type.${membership.type}`)}</TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {membership.levelCode}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {membership.teachers.join(", ") || tc("none")}
                        </TableCell>
                        <TableCell>{date(membership.joinedAt)}</TableCell>
                        <TableCell className="text-right">
                          <RemoveMembershipButton
                            membershipId={membership.id}
                            studentName={student.name}
                            groupName={membership.name}
                            today={today}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableCard>
            )}
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-medium">{t("groups.past")}</h2>
            {student.past.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("groups.nonePast")}
              </p>
            ) : (
              <TableCard>
                <Table data-testid="past-groups">
                  <TableCaption className="sr-only">
                    {t("groups.past")}
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("groups.group")}</TableHead>
                      <TableHead>{t("groups.joined")}</TableHead>
                      <TableHead>{t("groups.left")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {student.past.map((membership) => (
                      <TableRow key={membership.id}>
                        <TableCell className="font-medium">
                          <Link
                            href={`/admin/groups/${membership.groupId}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {membership.name}
                          </Link>
                        </TableCell>
                        <TableCell>{date(membership.joinedAt)}</TableCell>
                        <TableCell>{date(membership.leftAt!)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableCard>
            )}
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Own Suspense boundary: client navigations between admin pages re-render
// below the shared layout, so the shell's boundary doesn't cover them.
export default function Page(props: Parameters<typeof StudentPage>[0]) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <StudentPage {...props} />
    </Suspense>
  );
}
