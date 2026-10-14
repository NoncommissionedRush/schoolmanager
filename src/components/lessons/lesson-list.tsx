"use client";

import { Ban, NotebookPen, User, Users } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { formatMinutes, useDateFormat } from "@/components/timetable/format";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { LessonListItem } from "@/server/lessons/teacher";

function GroupCell({ group }: { group: LessonListItem["group"] }) {
  const Icon = group.type === "ONE_ON_ONE" ? User : Users;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
      {group.name}
    </span>
  );
}

function StatusBadge({ item }: { item: LessonListItem }) {
  const t = useTranslations("lessons.status");
  if (item.badge === "cancelled") {
    return (
      <Badge variant="destructive">
        <Ban aria-hidden="true" />
        {t("cancelled")}
      </Badge>
    );
  }
  if (item.badge === "noLog") {
    return (
      <Badge className="border-warning-border bg-warning-surface text-warning">
        <NotebookPen aria-hidden="true" />
        {t("noLog")}
      </Badge>
    );
  }
  return null;
}

function Excerpt({ text }: { text: string | null }) {
  const tc = useTranslations("common");
  return text ? (
    <span className="line-clamp-2 whitespace-pre-line">{text}</span>
  ) : (
    <span className="text-muted-foreground">{tc("none")}</span>
  );
}

/** Lesson list rows (lessons.md §5.4): a table, stacked cards on mobile. */
export function LessonList({
  items,
  hrefPrefix,
  hrefSuffix = "",
  showTeacher = false,
}: {
  items: LessonListItem[];
  /** Link of a row: `${hrefPrefix}${id}${hrefSuffix}`. */
  hrefPrefix: string;
  hrefSuffix?: string;
  /** Teacher column (admin list, §7). */
  showTeacher?: boolean;
}) {
  const hrefOf = (id: string) => `${hrefPrefix}${id}${hrefSuffix}`;
  const t = useTranslations("lessons.list.col");
  const tl = useTranslations("lessons.list");
  const teacherOf = (item: LessonListItem) =>
    item.substituteName
      ? tl("substituteFor", {
          substitute: item.substituteName,
          teacher: item.teacherName,
        })
      : item.teacherName;
  const formatDate = useDateFormat();
  const when = (item: LessonListItem) =>
    `${formatDate(item.date, "weekdayDate")}, ${formatMinutes(item.startMinute)}–${formatMinutes(item.endMinute)}`;

  return (
    <>
      <div className="hidden rounded-xl border bg-card md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("when")}</TableHead>
              <TableHead>{t("group")}</TableHead>
              {showTeacher && <TableHead>{t("teacher")}</TableHead>}
              <TableHead>{t("covered")}</TableHead>
              <TableHead>{t("homework")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="align-top whitespace-nowrap tabular-nums">
                  <div className="flex flex-col items-start gap-1">
                    <Link
                      href={hrefOf(item.id)}
                      className="font-medium text-primary hover:underline"
                    >
                      {when(item)}
                    </Link>
                    <StatusBadge item={item} />
                  </div>
                </TableCell>
                <TableCell className="align-top">
                  <GroupCell group={item.group} />
                </TableCell>
                {showTeacher && (
                  <TableCell className="align-top">{teacherOf(item)}</TableCell>
                )}
                <TableCell className="max-w-sm align-top whitespace-normal">
                  <Excerpt text={item.content} />
                </TableCell>
                <TableCell className="max-w-sm align-top whitespace-normal">
                  <Excerpt text={item.homework} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col gap-3 md:hidden">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={hrefOf(item.id)}
              className="flex min-h-11 flex-col gap-1.5 rounded-xl border bg-card p-4 text-sm"
            >
              <span className="flex flex-wrap items-center gap-2 font-medium tabular-nums">
                {when(item)}
                <StatusBadge item={item} />
              </span>
              <GroupCell group={item.group} />
              {showTeacher && (
                <span className="text-muted-foreground">{teacherOf(item)}</span>
              )}
              <span className="flex flex-col">
                <span className="text-muted-foreground">{t("covered")}</span>
                <Excerpt text={item.content} />
              </span>
              <span className="flex flex-col">
                <span className="text-muted-foreground">{t("homework")}</span>
                <Excerpt text={item.homework} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
