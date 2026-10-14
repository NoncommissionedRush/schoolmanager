import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { ListFilters } from "@/components/admin/list-filters";
import { ArchivedBadge, PageHeader, TableCard } from "@/components/admin/list";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listAvailability } from "@/server/admin/availability/service";
import { adminContext } from "@/server/admin/context";
import { param } from "@/server/admin/list";
import { lastPasswordChange } from "@/server/admin/people/service";
import { schoolToday } from "@/server/admin/shared";
import {
  getTeacher,
  listTerms,
  pickCurrentTerm,
  teacherSlots,
} from "@/server/admin/teachers/service";
import { formatMinutes, toIsoDate } from "@/server/scheduling/time";

import { AvailabilityTab } from "./availability-client";
import { parseTeacherTab } from "./tabs";
import {
  SetPasswordButton,
  TeacherHeaderActions,
  TeacherProfileForm,
  TeacherTabs,
} from "./teacher-detail-client";
import { TableSkeleton } from "@/components/admin/table-skeleton";

async function TeacherPage({
  params,
  searchParams,
}: PageProps<"/admin/teachers/[id]">) {
  const { db, viewer, ...scope } = await adminContext();
  const { id } = await params;
  const query = await searchParams;
  const teacher = await getTeacher(db, id);
  if (!teacher) notFound();

  const t = await getTranslations("teachers");
  const tp = await getTranslations("people");
  const tc = await getTranslations("common");
  const format = await getFormatter();
  const tab = parseTeacherTab(param(query, "tab"));
  const today = schoolToday(viewer.school.timezone);
  const todayIso = toIsoDate(today);

  const [availability, passwordSetAt, terms, school] = await Promise.all([
    listAvailability(db, teacher.id),
    lastPasswordChange({ db, ...scope }, teacher.userId),
    listTerms(db),
    db.school.findFirstOrThrow({ select: { teachingWeekdays: true } }),
  ]);
  const termParam = param(query, "term");
  const term =
    terms.find((candidate) => candidate.id === termParam) ??
    pickCurrentTerm(terms, today);
  const slots = term ? await teacherSlots(db, teacher.id, term.id) : [];
  const person = { userId: teacher.userId, name: teacher.name };
  const formatDate = (date: Date) =>
    format.dateTime(date, { dateStyle: "medium", timeZone: "UTC" });

  const profile = (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("profile.title")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <TeacherProfileForm teacher={teacher} />
        </CardContent>
      </Card>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>
            <h2>{tp("signIn")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">
            {passwordSetAt
              ? tp("lastPasswordChange", {
                  date: format.dateTime(passwordSetAt, "short"),
                })
              : tp("neverSet")}
          </p>
          <SetPasswordButton person={person} />
        </CardContent>
      </Card>
    </div>
  );

  const groups =
    terms.length === 0 || !term ? (
      <p className="text-sm text-muted-foreground">{t("groups.noTerms")}</p>
    ) : (
      <div className="flex flex-col gap-4">
        <ListFilters
          status={false}
          selects={[
            {
              name: "term",
              label: t("groups.term"),
              defaultValue: term.id,
              options: terms.map((option) => ({
                value: option.id,
                label: option.name,
              })),
            },
          ]}
        />
        {slots.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("groups.empty", { name: teacher.name, term: term.name })}
          </p>
        ) : (
          <TableCard>
            <Table>
              <TableCaption className="sr-only">
                {t("groups.caption", { name: teacher.name, term: term.name })}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("groups.col.group")}</TableHead>
                  <TableHead>{t("groups.col.level")}</TableHead>
                  <TableHead>{t("groups.col.time")}</TableHead>
                  <TableHead>{t("groups.col.room")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slots.map((slot) => (
                  <TableRow key={slot.id}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        <Link
                          href={`/admin/groups/${slot.group.id}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {slot.group.name}
                        </Link>
                        {slot.group.deletedAt && <ArchivedBadge />}
                      </span>
                    </TableCell>
                    <TableCell>{slot.group.level.code}</TableCell>
                    <TableCell>
                      {t("groups.time", {
                        weekday: tc(`weekday.${slot.weekday}` as "weekday.1"),
                        from: formatMinutes(slot.startMinute),
                        to: formatMinutes(slot.endMinute),
                      })}
                      {slot.validFrom && (
                        <span className="text-muted-foreground">
                          {" "}
                          {t("groups.validFrom", {
                            date: formatDate(slot.validFrom),
                          })}
                        </span>
                      )}
                      {slot.validUntil && (
                        <span className="text-muted-foreground">
                          {" "}
                          {t("groups.validUntil", {
                            date: formatDate(slot.validUntil),
                          })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {slot.room?.name ?? t("groups.noRoom")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCard>
        )}
      </div>
    );

  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <PageHeader
        back={{ href: "/admin/teachers", label: t("title") }}
        title={teacher.name}
        description={teacher.email}
        badges={teacher.archived && <ArchivedBadge />}
        actions={
          <TeacherHeaderActions person={person} archived={teacher.archived} />
        }
      />
      <TeacherTabs
        value={tab}
        panels={{
          profile,
          availability: (
            <AvailabilityTab
              teacherId={teacher.id}
              name={teacher.name}
              teachingWeekdays={school.teachingWeekdays}
              weekly={availability.weekly}
              exceptions={availability.exceptions.map((exception) => ({
                ...exception,
                past: exception.date < todayIso,
              }))}
            />
          ),
          groups,
        }}
      />
    </div>
  );
}

// Own Suspense boundary: client navigations between admin pages re-render
// below the shared layout, so the shell's boundary doesn't cover them.
export default function Page(props: Parameters<typeof TeacherPage>[0]) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <TeacherPage {...props} />
    </Suspense>
  );
}
