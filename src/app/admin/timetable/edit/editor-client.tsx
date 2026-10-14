"use client";

import { cn } from "cn";
import {
  MoreHorizontal,
  OctagonX,
  Plus,
  ShieldCheck,
  TriangleAlert,
  User,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { formatMinutes, useDateFormat } from "@/components/timetable/format";
import {
  type GridColumn,
  type GridItem,
  TimeGrid,
} from "@/components/timetable/time-grid";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  defaultEndDate,
  issueRows,
  slotIssueState,
  slotsAsOf,
} from "@/server/timetable/editor";
import type { EditorData, EditorSlot } from "@/server/timetable/editor-data";
import { gridHours, gridWeekdays } from "@/server/timetable/week";

import {
  DeleteSlotDialog,
  EndSlotDialog,
  IssuesSheet,
  PublishDialog,
  RegenerateDialog,
  useLessonResult,
} from "./editor-dialogs";
import { type SheetState, type SlotDraft, SlotSheet } from "./slot-sheet";

type View = "byRoom" | "week";
const NO_ROOM = "none";

/**
 * Admin timetable editor (timetable.md §5): term and "As of" pickers, By
 * room / Week views over the slot grid, filters, issues panel, slot sheet,
 * publish, end/delete and regenerate. All state that should survive a
 * reload lives in the URL.
 */
export function EditorClient({ data }: { data: EditorData }) {
  const t = useTranslations("timetable");
  const tc = useTranslations("common");
  const formatDate = useDateFormat();
  const lessonResult = useLessonResult();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const term = data.term!;
  const published = term.publishedAt !== null;

  const setParams = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const view: View = params.get("view") === "week" ? "week" : "byRoom";
  const filters = {
    teacher: params.get("teacher") ?? "",
    room: params.get("room") ?? "",
    group: params.get("group") ?? "",
  };
  const anyFilter = Boolean(filters.teacher || filters.room || filters.group);
  const asOf = data.asOf!;
  const visible = slotsAsOf(data.slots, asOf);
  const weekdays = gridWeekdays(
    data.school.teachingWeekdays,
    visible.map((s) => s.weekday),
  );
  const dayParam = Number(params.get("day"));
  const day = weekdays.includes(dayParam) ? dayParam : weekdays[0];

  const [sheet, setSheet] = useState<SheetState | null>(() => {
    const slotId = params.get("slot");
    const slot = slotId ? data.slots.find((s) => s.id === slotId) : undefined;
    return slot ? { mode: "edit", slot } : null;
  });
  const [highlight, setHighlight] = useState<string | null>(params.get("slot"));
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [includeAcknowledged, setIncludeAcknowledged] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [ending, setEnding] = useState<EditorSlot | null>(null);
  const [deleting, setDeleting] = useState<EditorSlot | null>(null);
  const [hideOthers, setHideOthers] = useState(false);
  const [lastDuration, setLastDuration] = useState(60);
  const [bannerHidden, setBannerHidden] = useState(false);

  const matches = (slot: EditorSlot) =>
    (!filters.teacher || slot.teacherId === filters.teacher) &&
    (!filters.room || slot.roomId === filters.room) &&
    (!filters.group || slot.groupId === filters.group);

  const issueCount = issueRows(
    data.issues,
    (id) => data.acknowledgements[id]?.keys ?? [],
    false,
  ).length;
  const missingBasics =
    data.groups.every((g) => g.archived) ||
    data.teachers.every((x) => x.archived);

  function showSlot(slotId: string) {
    const slot = data.slots.find((s) => s.id === slotId);
    if (!slot) return;
    setHighlight(slot.id);
    if (view === "byRoom") setParams({ day: String(slot.weekday) });
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-grid-item="${slot.id}"]`)
        ?.scrollIntoView({ block: "center", inline: "center" }),
    );
  }

  function openNew(changes: Partial<SlotDraft> = {}) {
    const start =
      changes.startMinute ?? Math.max(data.school.dayStartMinute, 8 * 60);
    setSheet({
      mode: "new",
      draft: {
        groupId: filters.group,
        teacherId: filters.teacher,
        roomId: filters.room,
        weekday: view === "byRoom" ? day : 1,
        startMinute: start,
        endMinute: Math.min(24 * 60, start + lastDuration),
        ...changes,
      },
    });
  }

  // --- Columns & blocks ---------------------------------------------------
  const roomById = new Map(data.rooms.map((r) => [r.id, r]));
  let columns: GridColumn[];
  let columnOf: (slot: EditorSlot) => string;
  let gridSlots: EditorSlot[];
  if (view === "byRoom") {
    const today = visible.filter((s) => s.weekday === day);
    gridSlots = hideOthers && anyFilter ? today.filter(matches) : today;
    const used = new Set(gridSlots.map((s) => s.roomId ?? NO_ROOM));
    const rooms = data.rooms.filter((r) => !r.archived || used.has(r.id));
    columns = rooms.map((r) => ({
      key: r.id,
      title: r.name,
      subtitle: r.archived
        ? tc("archivedBadge")
        : r.online
          ? t("editor.online")
          : r.capacity != null
            ? t("editor.seats", { count: r.capacity })
            : undefined,
    }));
    if (used.has(NO_ROOM)) {
      columns.push({ key: NO_ROOM, title: t("editor.noRoom") });
    }
    columnOf = (slot) => slot.roomId ?? NO_ROOM;
  } else {
    gridSlots = anyFilter ? visible.filter(matches) : [];
    columns = weekdays.map((d) => ({
      key: String(d),
      title: tc(`weekday.${d}` as "weekday.1"),
      hatched: filters.teacher
        ? data.unavailability
            .filter((u) => u.teacherId === filters.teacher && u.weekday === d)
            .map(({ startMinute, endMinute }) => ({ startMinute, endMinute }))
        : undefined,
    }));
    columnOf = (slot) => String(slot.weekday);
  }
  const hours = gridHours(data.school, gridSlots);

  const blockLabel = (
    slot: EditorSlot,
    state: ReturnType<typeof slotIssueState>,
  ) => {
    const parts = [
      slot.groupName,
      `${tc(`weekday.${slot.weekday}` as "weekday.1")} ${formatMinutes(slot.startMinute)}–${formatMinutes(slot.endMinute)}`,
      slot.teacherName,
      slot.roomId ? roomById.get(slot.roomId)?.name : t("editor.noRoom"),
    ];
    const conflicts = data.issues[slot.id] ?? [];
    const blocking = conflicts.filter((c) => c.severity === "blocking").length;
    const warnings = conflicts.length - blocking;
    if (blocking) parts.push(t("editor.conflictCount", { count: blocking }));
    if (warnings) parts.push(t("editor.warningCount", { count: warnings }));
    if (state === "acknowledged") parts.push(t("editor.acknowledged"));
    return parts.filter(Boolean).join(", ");
  };

  const items: GridItem[] = gridSlots.map((slot) => {
    const state = slotIssueState(
      data.issues[slot.id] ?? [],
      data.acknowledgements[slot.id]?.keys ?? [],
    );
    const ack = data.acknowledgements[slot.id];
    const dimmed = view === "byRoom" && anyFilter && !matches(slot);
    const room = slot.roomId ? roomById.get(slot.roomId) : undefined;
    const caption = slot.changedOn
      ? t("editor.changedOn", { date: formatDate(slot.changedOn, "dayMonth") })
      : slot.validFrom && slot.validFrom > term.startDate
        ? t("editor.fromDate", { date: formatDate(slot.validFrom, "dayMonth") })
        : slot.validUntil && slot.validUntil < term.endDate
          ? t("editor.untilDate", {
              date: formatDate(slot.validUntil, "dayMonth"),
            })
          : null;
    return {
      id: slot.id,
      column: columnOf(slot),
      startMinute: slot.startMinute,
      endMinute: slot.endMinute,
      overflowLabel: `${formatMinutes(slot.startMinute)} ${slot.groupName}`,
      onOverflowSelect: () => setSheet({ mode: "edit", slot }),
      render: ({ style, compact, ...rest }) => (
        <button
          type="button"
          {...rest}
          style={style}
          aria-label={blockLabel(slot, state)}
          onClick={() => {
            setHighlight(slot.id);
            setSheet({ mode: "edit", slot });
          }}
          onKeyDown={(event) => {
            if (event.key === "Delete") {
              event.preventDefault();
              if (published) setEnding(slot);
              else setDeleting(slot);
            } else if (event.key === "Escape") {
              setHighlight(null);
            } else rest.onKeyDown(event);
          }}
          className={cn(
            "flex flex-col overflow-hidden rounded-md border border-l-4 px-1.5 py-1 text-left text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            slot.groupType === "ONE_ON_ONE"
              ? "border-lesson-individual bg-lesson-individual-surface text-lesson-individual-text"
              : "border-lesson-group bg-lesson-group-surface text-lesson-group-text",
            dimmed && "opacity-40",
            highlight === slot.id && "shadow-sm ring-2 ring-ring",
          )}
        >
          <span className="flex items-center gap-1">
            {slot.groupType === "ONE_ON_ONE" ? (
              <User aria-hidden="true" className="size-3.5 shrink-0" />
            ) : (
              <Users aria-hidden="true" className="size-3.5 shrink-0" />
            )}
            <span className="tabular-nums">
              {formatMinutes(slot.startMinute)}–{formatMinutes(slot.endMinute)}
            </span>
            <span className="ml-auto flex items-center">
              {state === "blocking" && (
                <OctagonX aria-hidden="true" className="size-3.5 text-danger" />
              )}
              {state === "warning" && (
                <TriangleAlert
                  aria-hidden="true"
                  className="size-3.5 text-warning"
                />
              )}
              {state === "acknowledged" && ack && (
                <Tooltip>
                  <TooltipTrigger render={<span />}>
                    <ShieldCheck
                      aria-hidden="true"
                      className="size-3.5 text-muted-foreground"
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("editor.acknowledgedBy", {
                      name: ack.actorName,
                      date: formatDate(ack.at.slice(0, 10), "short"),
                    })}
                  </TooltipContent>
                </Tooltip>
              )}
            </span>
          </span>
          <span className="truncate font-semibold">{slot.groupName}</span>
          {!compact && <span className="truncate">{slot.teacherName}</span>}
          {!compact && view === "week" && (
            <span className="truncate">{room?.name ?? t("editor.noRoom")}</span>
          )}
          {!compact && caption && (
            <span className="truncate text-[0.65rem] opacity-80">
              {caption}
            </span>
          )}
        </button>
      ),
    };
  });

  const refresh = () => router.refresh();

  return (
    <div className="flex flex-col gap-4">
      {/* Page header */}
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="mr-auto text-2xl font-semibold">{t("editor.title")}</h1>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("editor.term")}
          <NativeSelect
            value={term.id}
            onChange={(e) => router.push(`${pathname}?term=${e.target.value}`)}
          >
            {data.terms.map((x) => (
              <NativeSelectOption key={x.id} value={x.id}>
                {x.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {published ? (
          <Badge className="mb-1.5 border-success-border bg-success-surface text-success">
            {t("editor.published", {
              date: formatDate(term.publishedAt!.slice(0, 10), "short"),
            })}
          </Badge>
        ) : (
          <Badge variant="secondary" className="mb-1.5">
            {t("editor.draft")}
          </Badge>
        )}
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("editor.asOf")}
          <Input
            type="date"
            className="h-8"
            value={asOf}
            min={term.startDate}
            max={term.endDate}
            onChange={(e) =>
              e.target.value && setParams({ asOf: e.target.value })
            }
          />
        </label>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="icon"
                aria-label={t("editor.more")}
              />
            }
          >
            <MoreHorizontal aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {published && (
              <DropdownMenuItem onClick={() => setRegenerateOpen(true)}>
                {t("editor.regenerate")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => router.push(`/admin/timetable?week=${asOf}`)}
            >
              {t("editor.viewPublished")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {!published && (
          <Button onClick={() => setPublishOpen(true)}>
            {t("publish.action")}
          </Button>
        )}
      </div>

      {published && !bannerHidden && (
        <Alert className="border-info-border bg-info-surface">
          <AlertDescription className="flex items-start justify-between gap-4">
            <span>{t("editor.publishedBanner")}</span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setBannerHidden(true)}
            >
              {tc("close")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {missingBasics && (
        <Alert>
          <AlertDescription className="flex flex-wrap gap-3">
            <span>{t("editor.missing")}</span>
            <Link
              className="font-medium text-primary hover:underline"
              href="/admin/groups"
            >
              {t("filter.group")}
            </Link>
            <Link
              className="font-medium text-primary hover:underline"
              href="/admin/teachers"
            >
              {t("filter.teacher")}
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {/* Toolbar */}
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="group"
            aria-label={t("editor.view.label")}
            className="flex items-center gap-1 rounded-lg bg-muted p-0.5"
          >
            {(["byRoom", "week"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setParams({ view: v === "byRoom" ? null : v })}
                className={cn(
                  "rounded-md px-2.5 py-1 text-sm font-medium",
                  view === v
                    ? "bg-background shadow-sm"
                    : "text-muted-foreground",
                )}
              >
                {t(`editor.view.${v}`)}
              </button>
            ))}
          </div>
          {view === "byRoom" && (
            <div
              role="group"
              aria-label={t("editor.day")}
              className="flex flex-wrap gap-1"
            >
              {weekdays.map((d) => (
                <Button
                  key={d}
                  size="sm"
                  variant={d === day ? "default" : "outline"}
                  aria-pressed={d === day}
                  onClick={() => setParams({ day: String(d) })}
                >
                  {tc(`weekdayShort.${d}` as "weekdayShort.1")}
                </Button>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {(
            [
              ["teacher", data.teachers],
              ["room", data.rooms],
              ["group", data.groups],
            ] as const
          ).map(([name, options]) => {
            // Archived ones only while they still have slots in this term.
            const inTerm = new Set(
              data.slots.map((s) =>
                name === "teacher"
                  ? s.teacherId
                  : name === "room"
                    ? s.roomId
                    : s.groupId,
              ),
            );
            const list = options
              .filter((o) => !o.archived || inTerm.has(o.id))
              .sort((a, b) => Number(a.archived) - Number(b.archived));
            return (
              <label
                key={name}
                className="flex flex-col gap-1 text-sm font-medium"
              >
                {t(`filter.${name}`)}
                <NativeSelect
                  value={filters[name]}
                  onChange={(e) =>
                    setParams({ [name]: e.target.value || null })
                  }
                >
                  <NativeSelectOption value="">
                    {t("filter.any")}
                  </NativeSelectOption>
                  {list.map((o) => (
                    <NativeSelectOption key={o.id} value={o.id}>
                      {o.archived
                        ? tc("archivedName", { name: o.name })
                        : o.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
            );
          })}
          {view === "byRoom" && anyFilter && (
            <label className="flex h-8 items-center gap-2 text-sm">
              <Checkbox
                checked={hideOthers}
                onCheckedChange={(c) => setHideOthers(c === true)}
              />
              {t("editor.hideOthers")}
            </label>
          )}
          {anyFilter && (
            <Button
              variant="ghost"
              onClick={() =>
                setParams({ teacher: null, room: null, group: null })
              }
            >
              {tc("clearFilters")}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {issueCount > 0 ? (
              <Button
                variant="outline"
                aria-label={t("editor.issuesCount", { count: issueCount })}
                onClick={() => setIssuesOpen(true)}
              >
                <TriangleAlert aria-hidden="true" className="text-warning" />
                {t("editor.issues")}
                <Badge variant="secondary">{issueCount}</Badge>
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setIssuesOpen(true)}
              >
                {t("editor.noIssues")}
              </Button>
            )}
            <Button onClick={() => openNew()}>
              <Plus aria-hidden="true" />
              {t("editor.newSlot")}
            </Button>
          </div>
        </div>
      </div>

      {/* Grid */}
      {view === "week" && !anyFilter ? (
        <Card className="p-10 text-center text-muted-foreground">
          {t("editor.weekNeedsFilter")}
        </Card>
      ) : (
        <div className="relative">
          <TimeGrid
            label={t("gridLabel", {
              range:
                view === "byRoom"
                  ? tc(`weekday.${day}` as "weekday.1")
                  : t("editor.view.week"),
            })}
            columns={columns}
            items={items}
            hours={hours}
            onEmptyClick={(column, minute) =>
              openNew(
                view === "byRoom"
                  ? {
                      weekday: day,
                      startMinute: minute,
                      roomId: column === NO_ROOM ? "" : column,
                    }
                  : { weekday: Number(column), startMinute: minute },
              )
            }
          />
          {data.slots.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-24">
              <Card className="pointer-events-auto flex flex-col items-center gap-2 p-6 text-center shadow-md">
                <h2 className="text-lg font-semibold">
                  {t("editor.empty.title")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("editor.empty.description")}
                </p>
                <Button onClick={() => openNew()}>
                  <Plus aria-hidden="true" />
                  {t("editor.newSlot")}
                </Button>
              </Card>
            </div>
          )}
        </div>
      )}

      <SlotSheet
        state={sheet}
        data={data}
        onClose={() => setSheet(null)}
        onShowSlot={showSlot}
        onSaved={(result, draft) => {
          setSheet(null);
          setHighlight(result.slotId);
          setLastDuration(draft.endMinute - draft.startMinute);
          toast.success(
            result.published
              ? t("toast.slotSavedResult", {
                  result: lessonResult(result.lessons),
                })
              : t("toast.slotSaved"),
          );
          refresh();
        }}
        onEnd={(slot) => {
          setSheet(null);
          setEnding(slot);
        }}
        onDelete={(slot) => {
          setSheet(null);
          setDeleting(slot);
        }}
        onDuplicate={(draft) => setSheet({ mode: "new", draft })}
      />
      <IssuesSheet
        open={issuesOpen}
        onOpenChange={setIssuesOpen}
        data={data}
        includeAcknowledged={includeAcknowledged}
        onIncludeAcknowledged={setIncludeAcknowledged}
        onShow={(slot) => {
          setIssuesOpen(false);
          if (view === "week")
            setParams({ view: null, day: String(slot.weekday) });
          showSlot(slot.id);
        }}
        onEdit={(slot) => {
          setIssuesOpen(false);
          setSheet({ mode: "edit", slot });
        }}
      />
      {!published && (
        <PublishDialog
          open={publishOpen}
          onOpenChange={setPublishOpen}
          data={data}
          onShowIssues={(includeAcked) => {
            setPublishOpen(false);
            setIncludeAcknowledged(includeAcked);
            setIssuesOpen(true);
          }}
          onPublished={refresh}
        />
      )}
      {published && (
        <RegenerateDialog
          open={regenerateOpen}
          termId={term.id}
          onOpenChange={setRegenerateOpen}
          onDone={refresh}
        />
      )}
      <EndSlotDialog
        slot={ending}
        data={data}
        defaultDate={
          ending ? defaultEndDate(ending, term, data.today) : data.today
        }
        onOpenChange={(open) => !open && setEnding(null)}
        onDone={() => {
          setEnding(null);
          refresh();
        }}
      />
      <DeleteSlotDialog
        slot={deleting}
        published={published}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDone={() => {
          setDeleting(null);
          refresh();
        }}
        onEndInstead={(slot) => {
          setDeleting(null);
          setEnding(slot);
        }}
      />
    </div>
  );
}

/** Below 1024 px the editor is replaced by a pointer to the weekly view (§5). */
export function DesktopOnlyNotice() {
  const t = useTranslations("timetable");
  return (
    <Alert>
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>{t("editor.desktopRecommended")}</span>
        <Link
          href="/admin/timetable"
          className={buttonVariants({ variant: "outline" })}
        >
          {t("editor.viewPublished")}
        </Link>
      </AlertDescription>
    </Alert>
  );
}
