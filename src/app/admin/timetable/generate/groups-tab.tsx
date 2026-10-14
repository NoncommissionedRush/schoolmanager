"use client";

import { cn } from "cn";
import {
  CircleCheck,
  MoreHorizontal,
  OctagonX,
  Search,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";

import { TableCard } from "@/components/admin/list";
import { useMessage } from "@/components/admin/use-message";
import { formatMinutes } from "@/components/timetable/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  GroupReadiness,
  ReadinessStatus,
} from "@/server/scheduling/generator";
import type { GeneratorPageData } from "@/server/timetable/generator-page";
import {
  hours,
  needsAttention,
  readinessCounts,
} from "@/server/timetable/generator-view";

import { setGroupSkippedAction } from "../generator-actions";
import type { Names } from "./use-names";

type Show = "all" | "attention" | "skipped";

const STATUS_TONE: Record<
  ReadinessStatus,
  "success" | "danger" | "warning" | "muted"
> = {
  READY: "success",
  KEPT: "muted",
  SKIPPED: "muted",
  NO_LESSON_TIMES: "danger",
  NO_ROOM: "danger",
  TIMES_CLASH: "danger",
  LEVEL_UNCOVERED: "warning",
};

/** Tab ① Groups: readiness checks and every group's status (§6.2). */
export function GroupsTab({
  data,
  names,
  readOnly,
}: {
  data: GeneratorPageData;
  names: Names;
  readOnly: boolean;
}) {
  const t = useTranslations("generator");
  const tc = useTranslations("common");
  const readiness = data.readiness!;
  const [q, setQ] = useState("");
  const [level, setLevel] = useState("");
  const [show, setShow] = useState<Show>("all");
  const counts = readinessCounts(readiness);
  const canTeach = (levelId: string) =>
    data.teachers.filter(
      (teacher) => !teacher.archived && teacher.levelIds.includes(levelId),
    );
  const query = q.trim().toLowerCase();
  const rows = readiness.groups
    .filter((g) => names.groups.has(g.groupId))
    .filter(
      (g) =>
        (!query || names.group(g.groupId).toLowerCase().includes(query)) &&
        (!level || g.levelId === level) &&
        (show === "all" ||
          (show === "attention" && needsAttention(g.status)) ||
          (show === "skipped" && g.status === "SKIPPED")),
    )
    .sort((a, b) =>
      names.group(a.groupId).localeCompare(names.group(b.groupId)),
    );
  const activeTeachers = data.teachers.filter(
    (teacher) => !teacher.archived && teacher.levelIds.length > 0,
  ).length;

  return (
    <div className="flex flex-col gap-4">
      <ReadinessCard
        data={data}
        names={names}
        onShow={(next) => setShow(next)}
      />
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label={t("groups.search")}
            placeholder={t("groups.search")}
            value={q}
            className="pl-8"
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <NativeSelect
          aria-label={t("groups.col.level")}
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          <NativeSelectOption value="">
            {t("groups.anyLevel")}
          </NativeSelectOption>
          {data.levels.map((l) => (
            <NativeSelectOption key={l.id} value={l.id}>
              {l.code}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <div role="group" aria-label={t("groups.show")} className="flex gap-1">
          {(["all", "attention", "skipped"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={show === value ? "secondary" : "ghost"}
              aria-pressed={show === value}
              onClick={() => setShow(value)}
            >
              {t(`groups.filter.${value}`)}
            </Button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {tc("noResults")}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setQ("");
              setLevel("");
              setShow("all");
            }}
          >
            {t("groups.clearFilters")}
          </Button>
        </div>
      ) : (
        <TableCard>
          <Table data-testid="readiness-table">
            <TableCaption className="sr-only">{t("tabs.groups")}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("groups.col.group")}</TableHead>
                <TableHead>{t("groups.col.level")}</TableHead>
                <TableHead>{t("groups.col.times")}</TableHead>
                <TableHead>{t("groups.col.room")}</TableHead>
                <TableHead>{t("groups.col.students")}</TableHead>
                <TableHead>{t("groups.col.canTeach")}</TableHead>
                <TableHead>{t("groups.col.status")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("groups.col.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((group) => {
                const teachers = canTeach(group.levelId);
                return (
                  <TableRow
                    key={group.groupId}
                    className={cn(group.status === "SKIPPED" && "opacity-60")}
                  >
                    <TableCell className="font-medium">
                      <Link
                        href={`/admin/groups/${group.groupId}?tab=details`}
                        className="underline-offset-4 hover:underline"
                      >
                        {names.group(group.groupId)}
                      </Link>
                    </TableCell>
                    <TableCell>{names.level(group.levelId)}</TableCell>
                    <TableCell className="tabular-nums">
                      {names.times(group.groupId) || "—"}
                    </TableCell>
                    <TableCell>
                      {names.groupRooms(group.groupId) || "—"}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {names.groups.get(group.groupId)?.members ?? 0}
                    </TableCell>
                    <TableCell>
                      <span title={teachers.map((x) => x.name).join(", ")}>
                        {t("groups.canTeachCount", { count: teachers.length })}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge group={group} names={names} />
                    </TableCell>
                    <TableCell className="text-right">
                      <GroupRowMenu
                        group={group}
                        termId={data.term!.id}
                        name={names.group(group.groupId)}
                        readOnly={readOnly}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableCard>
      )}
      <p className="text-sm text-muted-foreground">
        {t("groups.summary", {
          groups: counts.included,
          lessons: counts.lessons,
          need: hours(counts.minutes),
          teachers: activeTeachers,
          can: hours(readiness.checks.hours.availableMinutes),
        })}
      </p>
    </div>
  );
}

function StatusBadge({
  group,
  names,
}: {
  group: GroupReadiness;
  names: Names;
}) {
  const t = useTranslations("generator.groups.status");
  const tone = STATUS_TONE[group.status];
  const label =
    group.status === "LEVEL_UNCOVERED"
      ? t("noTeacherForLevel", { level: names.level(group.levelId) })
      : t(group.status);
  const Icon =
    tone === "success"
      ? CircleCheck
      : tone === "danger"
        ? OctagonX
        : TriangleAlert;
  return (
    <Badge
      variant="outline"
      className={cn(
        tone === "success" &&
          "border-success-border bg-success-surface text-success",
        tone === "danger" &&
          "border-danger-border bg-danger-surface text-danger",
        tone === "warning" &&
          "border-warning-border bg-warning-surface text-warning",
        tone === "muted" && "text-muted-foreground",
      )}
    >
      {tone !== "muted" && <Icon aria-hidden="true" />}
      {label}
    </Badge>
  );
}

function GroupRowMenu({
  group,
  termId,
  name,
  readOnly,
}: {
  group: GroupReadiness;
  termId: string;
  name: string;
  readOnly: boolean;
}) {
  const t = useTranslations("generator.groups");
  const tc = useTranslations("common");
  const render = useMessage();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const skipped = group.status === "SKIPPED";

  function setSkipped(next: boolean) {
    startTransition(async () => {
      const result = await setGroupSkippedAction({
        termId,
        groupId: group.groupId,
        skipped: next,
      });
      if (!result.ok) {
        toast.error(
          result.formError ? render(result.formError) : tc("error.unexpected"),
        );
        return;
      }
      toast.success(
        next ? t("skippedToast", { name }) : t("includedToast", { name }),
      );
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            disabled={pending}
            aria-label={tc("actionsFor", { name })}
          />
        }
      >
        <MoreHorizontal aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          render={<Link href={`/admin/groups/${group.groupId}?tab=details`} />}
        >
          {t("editGroup")}
        </DropdownMenuItem>
        {!readOnly && (
          <DropdownMenuItem onClick={() => setSkipped(!skipped)}>
            {skipped ? t("include") : t("skip")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Before you assign" (§6.2): cheap checks, recomputed on every load. */
function ReadinessCard({
  data,
  names,
  onShow,
}: {
  data: GeneratorPageData;
  names: Names;
  onShow: (show: Show) => void;
}) {
  const t = useTranslations("generator.ready");
  const { checks } = data.readiness!;
  const items: {
    tone: "danger" | "warning";
    text: string;
    action?: ReactNode;
  }[] = [];
  const link =
    "text-sm font-medium text-primary underline-offset-4 hover:underline";
  const showButton = (
    <button type="button" className={link} onClick={() => onShow("attention")}>
      {t("show")}
    </button>
  );
  const teachersLink = (
    <Link href="/admin/teachers" className={link}>
      {t("teachers")}
    </Link>
  );
  if (checks.noTimes.length > 0) {
    items.push({
      tone: "danger",
      text: t("noTimes", { count: checks.noTimes.length }),
      action: showButton,
    });
  }
  for (const clash of checks.roomClash) {
    items.push({
      tone: "danger",
      text: t("roomClash", {
        room: names.room(clash.roomId),
        groupA: names.group(clash.groupId),
        groupB: names.group(clash.otherGroupId),
      }),
      action: (
        <Link
          href={`/admin/groups/${clash.groupId}?tab=details`}
          className={link}
        >
          {t("editGroup")}
        </Link>
      ),
    });
  }
  for (const levelId of checks.levelUncovered) {
    const count = data.readiness!.groups.filter(
      (g) => g.levelId === levelId && g.status === "LEVEL_UNCOVERED",
    ).length;
    items.push({
      tone: "warning",
      text: t("levelUncovered", { level: names.level(levelId), count }),
      action: teachersLink,
    });
  }
  for (const crunch of checks.timeCrunch) {
    items.push({
      tone: "warning",
      text: t("timeCrunch", {
        day: names.weekdayShort(crunch.weekday),
        time: formatMinutes(crunch.minute),
        groups: crunch.groups,
        levels: crunch.levelId ? names.level(crunch.levelId) : t("allLevels"),
        teachers: crunch.teachers,
      }),
    });
  }
  if (checks.teachersNoLevels.length > 0) {
    items.push({
      tone: "warning",
      text: t("teachersNoLevels", { count: checks.teachersNoLevels.length }),
      action: teachersLink,
    });
  }
  if (checks.hours.neededMinutes > checks.hours.availableMinutes) {
    items.push({
      tone: "warning",
      text: t("hours", {
        need: hours(checks.hours.neededMinutes),
        can: hours(checks.hours.availableMinutes),
      }),
    });
  }
  if (checks.studentClash.length > 0) {
    items.push({
      tone: "warning",
      text: t("studentClash", { count: checks.studentClash.length }),
    });
  }
  return (
    <section
      aria-labelledby="readiness-title"
      className="flex flex-col gap-2 rounded-lg border p-4"
      data-testid="readiness-checks"
    >
      <h2 id="readiness-title" className="font-medium">
        {items.length > 0
          ? t("titleCount", { count: items.length })
          : t("title")}
      </h2>
      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-success">
          <CircleCheck aria-hidden="true" className="size-4" />
          {t("ok")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item, index) => (
            <li
              key={index}
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              {item.tone === "danger" ? (
                <OctagonX
                  aria-hidden="true"
                  className="size-4 shrink-0 text-danger"
                />
              ) : (
                <TriangleAlert
                  aria-hidden="true"
                  className="size-4 shrink-0 text-warning"
                />
              )}
              <span>{item.text}</span>
              {item.action}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
