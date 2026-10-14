"use client";

import { cn } from "cn";
import { CalendarDays, ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { addDays } from "@/server/scheduling";
import type { WeekData } from "@/server/timetable/views";
import type { LessonView, ViewerKind } from "@/server/timetable/week";

import { formatMinutes, useDateFormat } from "./format";
import { LessonDetailsSheet } from "./lesson-details";
import {
  LessonContent,
  lessonTone,
  toneClasses,
  useLessonText,
} from "./lesson-parts";
import { TimeGrid } from "./time-grid";

type FilterOption = { id: string; name: string; archived: boolean };

export type WeekFilterOptions = {
  teachers: FilterOption[];
  rooms: FilterOption[];
  groups: FilterOption[];
};

/** Builds `?…` links that keep the other parameters (week, view, filters). */
function useHref() {
  const pathname = usePathname();
  const params = useSearchParams();
  return (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  };
}

/**
 * Read-only weekly timetable (timetable.md §6) for every role: toolbar with
 * week navigation, desktop week grid or day list, mobile agenda with a day
 * strip, and the lesson details sheet.
 */
export function WeekView({
  data,
  role,
  today,
  nowMinute,
  view,
  filters,
  filterOptions,
}: {
  data: WeekData;
  role: ViewerKind;
  today: string;
  nowMinute: number;
  view: "week" | "day";
  filters?: { teacher?: string; room?: string; group?: string };
  filterOptions?: WeekFilterOptions;
}) {
  const t = useTranslations("timetable");
  const tc = useTranslations("common");
  const formatDate = useDateFormat();
  const format = useFormatter();
  const href = useHref();
  const router = useRouter();
  const lessonText = useLessonText(role);
  const [selected, setSelected] = useState<LessonView | null>(null);

  const inWeek = today >= data.week && today <= addDays(data.week, 6);
  const firstWithLessons = data.days.find((d) =>
    data.lessons.some((l) => l.date === d.date),
  )?.date;
  const [day, setDay] = useState(
    inWeek ? today : (firstWithLessons ?? data.days[0]?.date ?? data.week),
  );
  // A new week (navigation) starts from its default day again.
  const [shownWeek, setShownWeek] = useState(data.week);
  if (shownWeek !== data.week) {
    setShownWeek(data.week);
    setDay(
      inWeek ? today : (firstWithLessons ?? data.days[0]?.date ?? data.week),
    );
  }

  const weekLabel = t("weekRange", {
    start: formatDate(data.week, "dayMonth"),
    end: formatDate(addDays(data.week, 6), "short"),
  });
  const filtered = Boolean(filters?.teacher || filters?.room || filters?.group);
  const lessonsOn = (date: string) =>
    data.lessons.filter((l) => l.date === date);

  const weekdayName = (date: string) =>
    tc(`weekday.${isoWeekdayOf(date)}` as "weekday.1");

  const blockLabel = (lesson: LessonView) => {
    const text = lessonText(lesson);
    return t("blockLabel", {
      group: text.title,
      weekday: weekdayName(lesson.date),
      from: formatMinutes(lesson.startMinute),
      to: formatMinutes(lesson.endMinute),
      details: [text.typeText, text.subtitle, ...text.badges]
        .filter(Boolean)
        .join(", "),
    });
  };

  const emptyMessage = (() => {
    switch (data.state) {
      case "noGroups":
        return t("empty.noGroups");
      case "noTerm":
        return t("empty.noTerm");
      case "notPublished":
        return t("empty.none");
      default:
        return filtered ? t("empty.filtered") : t("empty.week");
    }
  })();
  const emptyHint =
    data.state === "noTerm" && data.nextTermStart
      ? t("empty.nextTerm", { date: formatDate(data.nextTermStart, "short") })
      : undefined;

  const nextLessonLink = data.nextLesson && (
    <Link
      href={href({ week: data.nextLesson.date })}
      className="text-sm font-medium text-primary underline-offset-4 hover:underline"
    >
      {t("empty.nextLesson", {
        date: formatDate(data.nextLesson.date, "weekdayDate"),
        time: format.dateTime(new Date(data.nextLesson.startsAt), "time"),
      })}
    </Link>
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <Link
          href={href({ week: addDays(data.week, -7) })}
          aria-label={t("prevWeek")}
          className={cn(
            buttonVariants({ variant: "outline", size: "icon" }),
            "size-11 md:size-8",
          )}
        >
          <ChevronLeft aria-hidden="true" />
        </Link>
        <Link
          href={href({ week: null })}
          className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-8")}
        >
          {t("today")}
        </Link>
        <Link
          href={href({ week: addDays(data.week, 7) })}
          aria-label={t("nextWeek")}
          className={cn(
            buttonVariants({ variant: "outline", size: "icon" }),
            "size-11 md:size-8",
          )}
        >
          <ChevronRight aria-hidden="true" />
        </Link>
      </div>
      <Popover>
        <PopoverTrigger
          className={cn(
            buttonVariants({ variant: "ghost" }),
            "h-11 text-base font-semibold md:h-8",
          )}
          aria-label={t("jumpToWeekLabel", { range: weekLabel })}
        >
          <CalendarDays aria-hidden="true" />
          {weekLabel}
        </PopoverTrigger>
        <PopoverContent className="w-60">
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("jumpToWeek")}
            <Input
              type="date"
              defaultValue={data.week}
              onChange={(event) => {
                if (event.target.value) {
                  router.push(href({ week: event.target.value }));
                }
              }}
            />
          </label>
        </PopoverContent>
      </Popover>
      <div
        role="group"
        aria-label={t("view.label")}
        className="ml-auto hidden items-center gap-1 rounded-lg bg-muted p-0.5 md:flex"
      >
        {(["week", "day"] as const).map((v) => (
          <Link
            key={v}
            href={href({ view: v === "week" ? null : v })}
            aria-current={view === v ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1 text-sm font-medium",
              view === v ? "bg-background shadow-sm" : "text-muted-foreground",
            )}
          >
            {t(`view.${v}`)}
          </Link>
        ))}
      </div>
      {role === "ADMIN" && (
        <Link
          href={`/admin/timetable/edit${data.termId ? `?term=${data.termId}` : ""}`}
          className={buttonVariants({ variant: "default" })}
        >
          <Pencil aria-hidden="true" />
          {t("editTimetable")}
        </Link>
      )}
    </div>
  );

  const adminFilters = role === "ADMIN" && filterOptions && (
    <div className="flex flex-wrap items-end gap-3">
      {(
        [
          ["teacher", filterOptions.teachers],
          ["room", filterOptions.rooms],
          ["group", filterOptions.groups],
        ] as const
      ).map(([name, options]) => (
        <label key={name} className="flex flex-col gap-1 text-sm font-medium">
          {t(`filter.${name}`)}
          <NativeSelect
            value={filters?.[name] ?? ""}
            onChange={(event) =>
              router.push(href({ [name]: event.target.value || null }))
            }
          >
            <NativeSelectOption value="">{t("filter.any")}</NativeSelectOption>
            {options.map((o) => (
              <NativeSelectOption key={o.id} value={o.id}>
                {o.archived ? tc("archivedName", { name: o.name }) : o.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ))}
      {filtered && (
        <Link
          href={href({ teacher: null, room: null, group: null })}
          className={buttonVariants({ variant: "ghost" })}
        >
          {tc("clearFilters")}
        </Link>
      )}
    </div>
  );

  const dayList = (date: string, headingLevel: "h2" | "h3" = "h2") => {
    const lessons = lessonsOn(date);
    const holiday = data.days.find((d) => d.date === date)?.holiday;
    const Heading = headingLevel;
    return (
      <section
        className="flex flex-col gap-3"
        aria-label={t("dayListLabel", {
          date: formatDate(date, "weekdayLong"),
        })}
      >
        <Heading className="text-lg font-semibold">
          {formatDate(date, "weekdayLong")}
        </Heading>
        {holiday && (
          <p className="rounded-lg border stripes px-3 py-2 text-sm">
            {t("holidayNamed", { name: holiday })}
          </p>
        )}
        {lessons.length === 0 ? (
          !holiday && (
            <p className="text-muted-foreground">
              {t("empty.day", { weekday: weekdayName(date) })}
            </p>
          )
        ) : (
          <ol className="flex flex-col gap-2">
            {lessons.map((lesson) => (
              <li key={lesson.id}>
                <button
                  type="button"
                  aria-label={blockLabel(lesson)}
                  onClick={() => setSelected(lesson)}
                  className={cn(
                    "w-full rounded-xl border border-l-4 p-3 text-left",
                    toneClasses[lessonTone(lesson)],
                  )}
                >
                  <LessonContent lesson={lesson} role={role} card />
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    );
  };

  const empty = data.lessons.length === 0;
  const fullEmpty = empty && data.state !== "ok";

  return (
    <div className="flex flex-col gap-4">
      {toolbar}
      {adminFilters}
      {fullEmpty ||
      (empty && !filtered && data.days.every((d) => !d.holiday)) ? (
        <EmptyState
          icon={CalendarDays}
          title={emptyMessage}
          description={emptyHint}
        >
          {nextLessonLink}
        </EmptyState>
      ) : (
        <>
          {empty && (
            <Card className="flex flex-col items-start gap-2 p-4 text-sm">
              <p>{emptyMessage}</p>
              {nextLessonLink}
            </Card>
          )}
          {/* Mobile: day strip + agenda (§6.5). */}
          <div className="flex flex-col gap-4 md:hidden">
            <div
              className="flex gap-1 overflow-x-auto"
              role="group"
              aria-label={weekLabel}
            >
              {Array.from({ length: 7 }, (_, i) => addDays(data.week, i)).map(
                (date) => {
                  const count = lessonsOn(date).length;
                  return (
                    <button
                      key={date}
                      type="button"
                      aria-pressed={date === day}
                      aria-label={t("dayChip", {
                        date: formatDate(date, "weekdayLong"),
                        count,
                      })}
                      onClick={() => setDay(date)}
                      className={cn(
                        "flex h-[52px] min-w-11 flex-1 flex-col items-center justify-center rounded-lg border text-sm",
                        date === day
                          ? "border-primary bg-primary text-primary-foreground"
                          : "bg-card",
                        date === today && date !== day && "ring-2 ring-ring",
                      )}
                    >
                      <span className="text-xs">
                        {tc(
                          `weekdayShort.${isoWeekdayOf(date)}` as "weekdayShort.1",
                        )}
                      </span>
                      <span className="font-semibold tabular-nums">
                        {Number(date.slice(8))}
                      </span>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-1 rounded-full",
                          count > 0 ? "bg-current" : "bg-transparent",
                        )}
                      />
                    </button>
                  );
                },
              )}
            </div>
            {dayList(day)}
          </div>
          {/* Desktop: week grid or day list. */}
          <div className="hidden md:block">
            {view === "day" ? (
              <div className="flex flex-col gap-4">
                <div
                  className="flex flex-wrap gap-1"
                  role="group"
                  aria-label={weekLabel}
                >
                  {data.days.map((d) => (
                    <Button
                      key={d.date}
                      variant={d.date === day ? "default" : "outline"}
                      aria-pressed={d.date === day}
                      onClick={() => setDay(d.date)}
                    >
                      {formatDate(d.date, "weekdayLong")}
                    </Button>
                  ))}
                </div>
                {dayList(day)}
              </div>
            ) : (
              <TimeGrid
                label={t("gridLabel", { range: weekLabel })}
                hours={data.hours}
                nowMinute={nowMinute}
                columns={data.days.map((d) => ({
                  key: d.date,
                  title: formatDate(d.date, "weekdayLong"),
                  subtitle: d.holiday
                    ? t("holidayNamed", { name: d.holiday })
                    : undefined,
                  current: d.date === today,
                  striped: Boolean(d.holiday),
                }))}
                items={data.lessons.map((lesson) => ({
                  id: lesson.id,
                  column: lesson.date,
                  startMinute: lesson.startMinute,
                  endMinute: lesson.endMinute,
                  overflowLabel: `${lessonText(lesson).time} ${lessonText(lesson).title}`,
                  onOverflowSelect: () => setSelected(lesson),
                  render: ({ style, compact, ...rest }) => (
                    <button
                      type="button"
                      {...rest}
                      style={style}
                      aria-label={blockLabel(lesson)}
                      title={blockLabel(lesson)}
                      onClick={() => setSelected(lesson)}
                      className={cn(
                        "overflow-hidden rounded-md border border-l-4 px-1.5 py-1 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        toneClasses[lessonTone(lesson)],
                      )}
                    >
                      <LessonContent
                        lesson={lesson}
                        role={role}
                        compact={compact}
                      />
                    </button>
                  ),
                }))}
              />
            )}
          </div>
        </>
      )}
      <LessonDetailsSheet
        lesson={selected}
        role={role}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </div>
  );
}

function isoWeekdayOf(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
