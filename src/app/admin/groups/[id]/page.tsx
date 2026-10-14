import { Suspense } from "react";
import { ExternalLink, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { ArchivedBadge, PageHeader, TableCard } from "@/components/admin/list";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
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
import { isFull, placesLeft } from "@/server/admin/groups/rules";
import {
  getGroup,
  groupFormOptions,
  memberCandidates,
} from "@/server/admin/groups/service";
import { param } from "@/server/admin/list";
import { schoolToday } from "@/server/admin/shared";
import { isUuid } from "@/server/admin/students/filters";
import { toIsoDate } from "@/server/scheduling";

import {
  AddMembersButton,
  GroupDetailsForm,
  GroupHeaderActions,
  RemoveMemberButton,
} from "./group-detail-client";
import { TableSkeleton } from "@/components/admin/table-skeleton";

const DATE = {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
} as const;

const TABS = ["members", "details", "timetable"] as const;

async function GroupPage({
  params,
  searchParams,
}: PageProps<"/admin/groups/[id]">) {
  const { db, viewer } = await adminContext();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const todayDate = schoolToday(viewer.school.timezone);
  const group = await getGroup(db, id, todayDate);
  if (!group) notFound();
  const t = await getTranslations("groups");
  const tc = await getTranslations("common");
  const format = await getFormatter();
  const tabParam = param(await searchParams, "tab");
  const tab = TABS.find((name) => name === tabParam) ?? "members";
  const today = toIsoDate(todayDate);
  const [options, candidates] = await Promise.all([
    groupFormOptions(db),
    memberCandidates(db, id, todayDate),
  ]);
  const date = (value: Date) => format.dateTime(value, DATE);
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
  const members = group.current.length;
  const groupData = {
    id: group.id,
    name: group.name,
    type: group.type,
    levelId: group.levelId,
    courseId: group.courseId,
    capacity: group.capacity,
    updatedAt: group.updatedAt.toISOString(),
    lessons: group.lessons,
    members,
    archived: !!group.deletedAt,
  };
  const editorHref = `/admin/timetable/edit?group=${group.id}&view=week`;

  return (
    <div className="mx-auto flex max-w-screen-xl flex-col gap-6">
      <PageHeader
        back={{ href: "/admin/groups", label: t("back") }}
        title={group.name}
        badges={
          <>
            <Badge variant="secondary">{t(`type.${group.type}`)}</Badge>
            <Badge variant="outline">
              {group.level.archivedAt
                ? tc("archivedName", { name: group.level.code })
                : group.level.code}
            </Badge>
            {group.deletedAt && <ArchivedBadge />}
          </>
        }
        description={
          <span className="flex items-center gap-2">
            {t("membersHeader", { count: members, capacity: group.capacity })}
            {isFull(group.capacity, members) && (
              <Badge variant="secondary">{t("full")}</Badge>
            )}
          </span>
        }
        actions={<GroupHeaderActions group={groupData} options={formOptions} />}
      />
      <Tabs defaultValue={tab}>
        <TabsList>
          <TabsTrigger value="members">{t("tab.members")}</TabsTrigger>
          <TabsTrigger value="details">{t("tab.details")}</TabsTrigger>
          <TabsTrigger value="timetable">{t("tab.timetable")}</TabsTrigger>
        </TabsList>

        <TabsContent value="members" className="flex flex-col gap-4 pt-4">
          {!group.deletedAt && (
            <div className="flex flex-wrap items-center gap-3">
              <AddMembersButton
                group={{
                  id: group.id,
                  name: group.name,
                  levelId: group.levelId,
                  placesLeft: placesLeft(group.capacity, members),
                }}
                candidates={candidates}
                today={today}
              />
              <p className="text-sm text-muted-foreground">
                {t("members.placesLeft", {
                  count: placesLeft(group.capacity, members),
                })}
              </p>
            </div>
          )}
          {members === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("members.empty")}
            </p>
          ) : (
            <TableCard>
              <Table>
                <TableCaption className="sr-only">
                  {t("tab.members")}
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("members.name")}</TableHead>
                    <TableHead>{t("members.level")}</TableHead>
                    <TableHead>{t("members.joined")}</TableHead>
                    <TableHead>
                      <span className="sr-only">{t("members.remove")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.current.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell className="font-medium">
                        <span className="flex items-center gap-2">
                          <Link
                            href={`/admin/students/${member.studentId}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {member.name}
                          </Link>
                          {member.archived && <ArchivedBadge />}
                        </span>
                      </TableCell>
                      <TableCell>
                        {member.levelCode && member.otherLevel ? (
                          <Badge variant="destructive">
                            <TriangleAlert aria-hidden="true" />
                            {t("members.levelTag", { level: member.levelCode })}
                          </Badge>
                        ) : (
                          (member.levelCode ?? tc("none"))
                        )}
                      </TableCell>
                      <TableCell>{date(member.joinedAt)}</TableCell>
                      <TableCell className="text-right">
                        <RemoveMemberButton
                          membershipId={member.id}
                          studentName={member.name}
                          groupName={group.name}
                          today={today}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableCard>
          )}
          <details className="group/past rounded-lg border p-4">
            <summary className="cursor-pointer font-medium">
              {t("members.past")}
              <span className="ml-2 text-muted-foreground tabular-nums">
                {group.past.length}
              </span>
            </summary>
            {group.past.length === 0 ? (
              <p className="pt-3 text-sm text-muted-foreground">
                {t("members.noPast")}
              </p>
            ) : (
              <Table className="mt-3" data-testid="past-members">
                <TableCaption className="sr-only">
                  {t("members.past")}
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("members.name")}</TableHead>
                    <TableHead>{t("members.joined")}</TableHead>
                    <TableHead>{t("members.left")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.past.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell>
                        <Link
                          href={`/admin/students/${member.studentId}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {member.name}
                        </Link>
                      </TableCell>
                      <TableCell>{date(member.joinedAt)}</TableCell>
                      <TableCell>{date(member.leftAt!)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </details>
        </TabsContent>

        <TabsContent value="details" className="pt-4">
          <Card className="max-w-2xl p-6">
            <GroupDetailsForm group={groupData} options={formOptions} />
          </Card>
        </TabsContent>

        <TabsContent value="timetable" className="flex flex-col gap-4 pt-4">
          <div>
            <Link
              href={editorHref}
              className={buttonVariants({ variant: "outline" })}
            >
              <ExternalLink aria-hidden="true" />
              {t("openInEditor")}
            </Link>
          </div>
          {group.terms.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("timetable.empty")}
            </p>
          ) : (
            group.terms.map((term) => (
              <section key={term.id} className="flex flex-col gap-2">
                <h2 className="text-lg font-medium">{term.name}</h2>
                <TableCard>
                  <Table>
                    <TableCaption className="sr-only">{term.name}</TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("timetable.weekday")}</TableHead>
                        <TableHead>{t("timetable.time")}</TableHead>
                        <TableHead>{t("timetable.teacher")}</TableHead>
                        <TableHead>{t("timetable.room")}</TableHead>
                        <TableHead>{t("timetable.valid")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {term.slots.map((slot) => (
                        <TableRow key={slot.id}>
                          <TableCell>
                            {tc(
                              `weekday.${slot.weekday as 1 | 2 | 3 | 4 | 5 | 6 | 7}`,
                            )}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {tc("timeRange", { from: slot.from, to: slot.to })}
                          </TableCell>
                          <TableCell>{slot.teacher}</TableCell>
                          <TableCell>
                            <span className="flex items-center gap-2">
                              {slot.room ?? t("timetable.noRoom")}
                              {slot.roomArchived && <ArchivedBadge />}
                            </span>
                          </TableCell>
                          <TableCell>
                            {slot.validFrom && slot.validUntil
                              ? t("timetable.between", {
                                  from: date(slot.validFrom),
                                  to: date(slot.validUntil),
                                })
                              : slot.validFrom
                                ? t("timetable.from", {
                                    date: date(slot.validFrom),
                                  })
                                : slot.validUntil
                                  ? t("timetable.until", {
                                      date: date(slot.validUntil),
                                    })
                                  : t("timetable.whole")}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableCard>
              </section>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Own Suspense boundary: client navigations between admin pages re-render
// below the shared layout, so the shell's boundary doesn't cover them.
export default function Page(props: Parameters<typeof GroupPage>[0]) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <GroupPage {...props} />
    </Suspense>
  );
}
