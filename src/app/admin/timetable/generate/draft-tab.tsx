"use client";

import { cn } from "cn";
import {
  ChevronDown,
  FilePenLine,
  Lock,
  LockOpen,
  OctagonX,
  TriangleAlert,
  WandSparkles,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { TableCard } from "@/components/admin/list";
import { useMessage } from "@/components/admin/use-message";
import { EmptyState } from "@/components/empty-state";
import { useConflictMessage } from "@/components/timetable/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  PickerSection,
  TeacherOption,
  UnassignedGroup,
} from "@/server/scheduling/generator";
import type { GeneratorPageData } from "@/server/timetable/generator-page";
import type {
  DraftEditResult,
  DraftView,
} from "@/server/timetable/generator-service";
import {
  compareSummary,
  type DraftRow,
  draftRows,
  hours,
  readDraftJson,
  workloadRange,
  workloadRows,
} from "@/server/timetable/generator-view";

import {
  checkDraftAction,
  saveAssignmentAction,
  setAssignmentsLockedAction,
  teacherOptionsAction,
} from "../generator-actions";
import { PublishDialog } from "./publish-dialog";
import { type Names, useReasonMessages } from "./use-names";

type View = "byGroup" | "byTeacher";

const SECTIONS: PickerSection[] = [
  "AVAILABLE",
  "UNAVAILABLE",
  "NOT_TEACHING_LEVEL",
  "OVER_MAX_HOURS",
  "BUSY",
];

/** Draft edits: keeps the version current and reports refusals. */
function useDraftEdit(draft: DraftView, onDraft: (draft: DraftView) => void) {
  const t = useTranslations("generator");
  const tc = useTranslations("common");
  const render = useMessage();
  const router = useRouter();
  const version = useRef(draft.version);
  useEffect(() => {
    version.current = Math.max(version.current, draft.version);
  }, [draft.version]);
  const [pending, startTransition] = useTransition();

  function apply(
    run: (
      version: number,
    ) => Promise<
      | { ok: true; data: DraftEditResult }
      | { ok: false; formError?: { key: string } }
    >,
    done?: () => void,
  ) {
    startTransition(async () => {
      const result = await run(version.current);
      if (!result.ok) {
        toast.error(
          result.formError ? render(result.formError) : tc("error.unexpected"),
        );
        return;
      }
      const edit = result.data;
      if (edit.ok) {
        version.current = edit.draft.version;
        onDraft(edit.draft);
        done?.();
        router.refresh();
      } else if (edit.reason === "DRAFT_CHANGED") {
        version.current = edit.draft.version;
        onDraft(edit.draft);
        toast.error(t("draft.changedByOther"));
      } else {
        toast.error(
          render({ key: "scheduling.generator.errors.BLOCKING_CONFLICTS" }),
        );
      }
    });
  }
  return { apply, pending };
}

/** Tab ② Draft (§6.5–6.8, §6.10–6.11). */
export function DraftTab({
  data,
  names,
  draft,
  running,
  readOnly,
  onDraft,
  onAssign,
}: {
  data: GeneratorPageData;
  names: Names;
  /** Null until a run has finished. */
  draft: DraftView | null;
  running: boolean;
  readOnly: boolean;
  onDraft: (draft: DraftView) => void;
  onAssign: () => void;
}) {
  const t = useTranslations("generator");
  if (!draft) {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <EmptyState
          icon={WandSparkles}
          title={t("draft.empty.title")}
          description={t("draft.empty.description")}
        />
        {!readOnly && (
          <Button onClick={onAssign} disabled={running}>
            {t("actions.assign")}
          </Button>
        )}
      </div>
    );
  }
  return (
    <DraftReview
      data={data}
      names={names}
      draft={draft}
      running={running}
      readOnly={readOnly}
      onDraft={onDraft}
      onAssign={onAssign}
    />
  );
}

function DraftReview({
  data,
  names,
  draft,
  running,
  readOnly,
  onDraft,
  onAssign,
}: {
  data: GeneratorPageData;
  names: Names;
  draft: DraftView;
  running: boolean;
  readOnly: boolean;
  onDraft: (draft: DraftView) => void;
  onAssign: () => void;
}) {
  const t = useTranslations("generator");
  const format = useFormatter();
  const render = useMessage();
  const [view, setView] = useState<View>("byGroup");
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  const [compare, setCompare] = useState(false);
  const [why, setWhy] = useState<string | "all" | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [checking, startChecking] = useTransition();
  const { apply, pending } = useDraftEdit(draft, onDraft);
  const json = readDraftJson(draft);
  const rows = draftRows(
    draft.assignments,
    json.unassigned,
    json.warnings,
    data.readiness!.groups,
    names.group,
  );
  const workload = workloadRows(
    rows,
    data.readiness!.groups,
    data.teachers,
    (id) => names.teacher(id),
  );
  const range = workloadRange(workload);
  const compared = compareSummary(
    rows,
    (id) => names.groups.get(id)?.members ?? 0,
  );
  const assigned = rows.filter((row) => row.teacherId).length;
  const without = rows.length - assigned;
  const warningCount =
    rows.reduce((n, row) => n + row.conflicts.length, 0) +
    json.warnings.teachers.length;
  const blockingCount = rows.reduce(
    (n, row) =>
      n + row.conflicts.filter((c) => c.severity === "blocking").length,
    0,
  );
  const previous = json.summary?.previousRange;
  const shown = onlyUnassigned ? rows.filter((row) => !row.teacherId) : rows;
  const editable = !readOnly && !running;

  function checkDraft() {
    startChecking(async () => {
      const result = await checkDraftAction(draft.id);
      if (!result.ok) {
        toast.error(
          render(result.formError ?? { key: "common.error.unexpected" }),
        );
        return;
      }
      onDraft(result.data);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <section
        className="flex flex-col gap-3 rounded-lg border border-info-border bg-info-surface p-4"
        aria-labelledby="draft-band"
        data-testid="draft-summary"
      >
        <div className="flex flex-wrap items-center gap-2">
          <FilePenLine aria-hidden="true" className="size-4 text-info" />
          <h2 id="draft-band" className="font-medium">
            {t("draft.band")}
          </h2>
          {draft.generatedAt && (
            <span className="ml-auto text-sm text-muted-foreground">
              {data.latestRunBy
                ? t("draft.assignedBy", {
                    date: format.dateTime(new Date(draft.generatedAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                    name: data.latestRunBy,
                  })
                : t("draft.assignedAt", {
                    date: format.dateTime(new Date(draft.generatedAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-stretch gap-3">
          <SummaryCard
            title={t("draft.assigned")}
            tone={without === 0 ? "success" : undefined}
          >
            {t("draft.assignedValue", { assigned, total: rows.length })}
          </SummaryCard>
          <SummaryCard
            title={t("draft.noTeacher")}
            tone={without > 0 ? "danger" : undefined}
          >
            <span>{t("draft.noTeacherValue", { count: without })}</span>
            {without > 0 && (
              <button
                type="button"
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                onClick={() => setWhy("all")}
              >
                {t("draft.show")}
              </button>
            )}
          </SummaryCard>
          <SummaryCard title={t("workload.title")}>
            {range ? (
              <>
                <span>
                  {t("workload.range", {
                    min: hours(range.min),
                    max: hours(range.max),
                  })}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("workload.average", { average: hours(range.average) })}
                  {previous && (
                    <>
                      {" · "}
                      {t("workload.previous", {
                        min: hours(previous.minMinutes),
                        max: hours(previous.maxMinutes),
                      })}
                    </>
                  )}
                </span>
                <button
                  type="button"
                  className="w-fit text-sm font-medium text-primary underline-offset-4 hover:underline"
                  onClick={() => setView("byTeacher")}
                >
                  {t("workload.details")}
                </button>
              </>
            ) : (
              "—"
            )}
          </SummaryCard>
          <SummaryCard
            title={t("draft.issues")}
            tone={
              blockingCount > 0
                ? "danger"
                : warningCount > 0
                  ? "warning"
                  : undefined
            }
          >
            {t("draft.issuesValue", {
              conflicts: blockingCount,
              warnings: warningCount - blockingCount,
            })}
          </SummaryCard>
          <div className="ml-auto flex flex-col justify-end gap-2">
            {compared.hasCurrent && (
              <Button
                variant="outline"
                aria-pressed={compare}
                onClick={() => setCompare((value) => !value)}
              >
                {compare
                  ? t("compare.toggleDraft")
                  : t("compare.toggleCompare")}
              </Button>
            )}
            {editable && (
              <Button onClick={() => setPublishOpen(true)}>
                {t("publish.action")}
              </Button>
            )}
          </div>
        </div>
      </section>

      {draft.outOfDate && (
        <Alert className="border-warning-border bg-warning-surface">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {t("draft.stale")}
            {editable && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={checkDraft}
                  disabled={checking}
                >
                  {t("draft.check")}
                </Button>
                <Button size="sm" variant="outline" onClick={onAssign}>
                  {t("actions.reassign")}
                </Button>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}
      {assigned === 0 && rows.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>{t("draft.nobodyAssigned")}</AlertDescription>
        </Alert>
      )}
      {compare && (
        <p className="text-sm" data-testid="compare-summary">
          {t("compare.summary", {
            changed: compared.changed,
            teachers: compared.teachers,
            students: compared.students,
          })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div
          role="group"
          aria-label={t("draft.view.label")}
          className="flex gap-1"
        >
          {(["byGroup", "byTeacher"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={view === value ? "secondary" : "ghost"}
              aria-pressed={view === value}
              onClick={() => setView(value)}
            >
              {t(`draft.view.${value}`)}
            </Button>
          ))}
        </div>
        {view === "byGroup" && (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={onlyUnassigned}
                onChange={(e) => setOnlyUnassigned(e.target.checked)}
              />
              {t("draft.onlyUnassigned")}
            </label>
            {editable && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button size="sm" variant="outline" disabled={pending} />
                  }
                >
                  {t("lock.menu")}
                  <ChevronDown aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    disabled={!rows.some((row) => row.teacherId && !row.locked)}
                    onClick={() =>
                      apply((version) =>
                        setAssignmentsLockedAction({
                          draftId: draft.id,
                          version,
                          groupIds: rows
                            .filter((row) => row.teacherId)
                            .map((row) => row.groupId),
                          locked: true,
                        }),
                      )
                    }
                  >
                    {t("lock.allAssigned")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!rows.some((row) => row.locked)}
                    onClick={() =>
                      apply((version) =>
                        setAssignmentsLockedAction({
                          draftId: draft.id,
                          version,
                          groupIds: rows.map((row) => row.groupId),
                          locked: false,
                        }),
                      )
                    }
                  >
                    {t("lock.unlockAll")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        )}
      </div>

      {view === "byGroup" ? (
        <ByGroupTable
          rows={shown}
          names={names}
          draft={draft}
          compare={compare}
          editable={editable}
          pending={pending}
          apply={apply}
          onWhy={(groupId) => setWhy(groupId)}
        />
      ) : (
        <ByTeacherTable
          rows={workload}
          draftRows={rows}
          names={names}
          draft={draft}
          editable={editable}
          apply={apply}
          average={range?.average ?? 0}
        />
      )}

      <WhySheet
        open={why !== null}
        onOpenChange={(open) => !open && setWhy(null)}
        groups={
          why === "all"
            ? json.unassigned
            : json.unassigned.filter((u) => u.groupId === why)
        }
        rows={rows}
        names={names}
        draft={draft}
        editable={editable}
        apply={apply}
        onReassign={() => {
          setWhy(null);
          onAssign();
        }}
      />
      {publishOpen && (
        <PublishDialog
          open={publishOpen}
          onOpenChange={setPublishOpen}
          data={data}
          names={names}
          draft={draft}
          rows={rows}
        />
      )}
    </div>
  );
}

function SummaryCard({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: "success" | "danger" | "warning";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-40 flex-col gap-1 rounded-lg border bg-background p-3 text-sm",
        tone === "success" && "border-success-border",
        tone === "danger" && "border-danger-border",
        tone === "warning" && "border-warning-border",
      )}
    >
      <span className="text-xs font-medium text-muted-foreground uppercase">
        {title}
      </span>
      <div
        className={cn(
          "flex flex-col gap-0.5 font-medium",
          tone === "success" && "text-success",
          tone === "danger" && "text-danger",
        )}
      >
        {children}
      </div>
    </div>
  );
}

type Apply = ReturnType<typeof useDraftEdit>["apply"];

function ByGroupTable({
  rows,
  names,
  draft,
  compare,
  editable,
  pending,
  apply,
  onWhy,
}: {
  rows: DraftRow[];
  names: Names;
  draft: DraftView;
  compare: boolean;
  editable: boolean;
  pending: boolean;
  apply: Apply;
  onWhy: (groupId: string) => void;
}) {
  const t = useTranslations("generator");
  const conflictMessage = useConflictMessage();
  const reasons = useReasonMessages(names);
  return (
    <TableCard>
      <Table data-testid="draft-table">
        <TableCaption className="sr-only">
          {t("draft.view.byGroup")}
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>{t("groups.col.group")}</TableHead>
            <TableHead>{t("groups.col.level")}</TableHead>
            <TableHead>{t("groups.col.times")}</TableHead>
            <TableHead>{t("groups.col.room")}</TableHead>
            <TableHead>{t("draft.col.teacher")}</TableHead>
            {compare && <TableHead>{t("compare.was")}</TableHead>}
            <TableHead>
              <span className="sr-only">{t("lock.column")}</span>
              <Lock aria-hidden="true" className="size-4" />
            </TableHead>
            <TableHead>{t("draft.col.notes")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const name = names.group(row.groupId);
            const level = names.groups.get(row.groupId)?.levelId ?? "";
            return (
              <TableRow
                key={row.groupId}
                data-testid="draft-row"
                className={cn(
                  !row.teacherId && "bg-danger-surface/50",
                  compare && !row.changed && "opacity-60",
                )}
              >
                <TableCell className="font-medium">
                  <span className="flex items-center gap-1.5">
                    {!row.teacherId && (
                      <OctagonX
                        aria-hidden="true"
                        className="size-4 text-danger"
                      />
                    )}
                    {name}
                  </span>
                </TableCell>
                <TableCell>{names.level(level)}</TableCell>
                <TableCell className="tabular-nums">
                  {names.times(row.groupId) || "—"}
                </TableCell>
                <TableCell>{names.groupRooms(row.groupId) || "—"}</TableCell>
                <TableCell>
                  <TeacherPicker
                    row={row}
                    names={names}
                    draft={draft}
                    disabled={!editable || pending}
                    apply={apply}
                  />
                </TableCell>
                {compare && (
                  <TableCell>
                    {row.changed && (
                      <span className="flex items-center gap-1.5">
                        {names.teacher(row.currentTeacherId)}
                        <Badge className="border-warning-border bg-warning-surface text-warning">
                          {t("compare.changed")}
                        </Badge>
                      </span>
                    )}
                  </TableCell>
                )}
                <TableCell>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-pressed={row.locked}
                    aria-label={t("lock.toggle", { group: name })}
                    disabled={!editable || pending}
                    onClick={() =>
                      apply((version) =>
                        setAssignmentsLockedAction({
                          draftId: draft.id,
                          version,
                          groupIds: [row.groupId],
                          locked: !row.locked,
                        }),
                      )
                    }
                  >
                    {row.locked ? (
                      <Lock aria-hidden="true" />
                    ) : (
                      <LockOpen
                        aria-hidden="true"
                        className="text-muted-foreground"
                      />
                    )}
                  </Button>
                </TableCell>
                <TableCell className="max-w-sm text-sm">
                  <div className="flex flex-col gap-1">
                    {row.unassigned && (
                      <span className="flex flex-wrap items-center gap-1.5">
                        {reasons.groupReason(
                          row.unassigned.reason,
                          row.unassigned.params as Record<string, unknown>,
                        )}
                        <button
                          type="button"
                          className="font-medium text-primary underline-offset-4 hover:underline"
                          onClick={() => onWhy(row.groupId)}
                        >
                          {t("unassigned.why")}
                          <span className="sr-only">{name}</span>
                        </button>
                      </span>
                    )}
                    {row.notices.map((notice) => (
                      <span key={notice.code} className="text-muted-foreground">
                        {t(`notices.${notice.code as "MIXED_TEACHERS"}`)}
                      </span>
                    ))}
                    {row.conflicts.map((conflict) => (
                      <span
                        key={conflict.draftKey}
                        className={cn(
                          "flex items-start gap-1",
                          conflict.severity === "blocking"
                            ? "text-danger"
                            : "text-warning",
                        )}
                      >
                        <TriangleAlert
                          aria-hidden="true"
                          className="mt-0.5 size-3.5 shrink-0"
                        />
                        {conflictMessage(conflict)}
                      </span>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableCard>
  );
}

/**
 * The teacher picker (§6.6): sections from the service; Busy teachers are
 * listed with their reason but can't be chosen.
 */
function TeacherPicker({
  row,
  names,
  draft,
  disabled,
  apply,
}: {
  row: DraftRow;
  names: Names;
  draft: DraftView;
  disabled: boolean;
  apply: Apply;
}) {
  const t = useTranslations("generator");
  const render = useMessage();
  const reasons = useReasonMessages(names);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<TeacherOption[] | null>(null);
  const [query, setQuery] = useState("");
  const groupName = names.group(row.groupId);
  const levelId = names.groups.get(row.groupId)?.levelId ?? "";
  const minutes = row.minutes;

  async function load() {
    setOptions(null);
    const result = await teacherOptionsAction({
      draftId: draft.id,
      groupId: row.groupId,
    });
    if (!result.ok) {
      toast.error(
        render(result.formError ?? { key: "common.error.unexpected" }),
      );
      setOpen(false);
      return;
    }
    setOptions(result.data);
  }

  function choose(teacherId: string | null) {
    setOpen(false);
    apply(
      (version) =>
        saveAssignmentAction({
          draftId: draft.id,
          version,
          groupId: row.groupId,
          teacherId,
        }),
      () =>
        toast.success(
          teacherId
            ? t("draft.teacherSet", {
                teacher: names.teacher(teacherId),
                group: groupName,
              })
            : t("draft.teacherRemoved", { group: groupName }),
        ),
    );
  }

  const workload = (teacherId: string) =>
    draft.assignments
      .filter((a) => a.teacherId === teacherId && a.groupId !== row.groupId)
      .reduce(
        (sum, a) =>
          sum +
          (names.groups
            .get(a.groupId)
            ?.lessonTimes.reduce(
              (m, x) => m + x.endMinute - x.startMinute,
              0,
            ) ?? 0),
        0,
      );
  const q = query.trim().toLowerCase();

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-label={t("picker.label", { group: groupName })}
            className={cn("justify-between", !row.teacherId && "text-danger")}
          />
        }
      >
        {row.teacherId ? names.teacher(row.teacherId) : t("picker.choose")}
        <ChevronDown aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 gap-1 p-1.5">
        <input
          type="search"
          aria-label={t("picker.search")}
          placeholder={t("picker.search")}
          className="mb-1 h-8 rounded-md border px-2 text-sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
          onClick={() => choose(null)}
        >
          {t("picker.noTeacher")}
        </button>
        {options === null ? (
          <p
            className="px-2 py-1.5 text-sm text-muted-foreground"
            role="status"
          >
            {t("picker.loading")}
          </p>
        ) : (
          <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {SECTIONS.map((section) => {
              const items = options
                .filter((o) => o.section === section)
                .filter(
                  (o) =>
                    !q || names.teacher(o.teacherId).toLowerCase().includes(q),
                )
                .sort((a, b) =>
                  names
                    .teacher(a.teacherId)
                    .localeCompare(names.teacher(b.teacherId)),
                );
              if (items.length === 0) return null;
              const label = t(`picker.sections.${section}`, {
                level: names.level(levelId),
              });
              return (
                <div key={section} role="group" aria-label={label}>
                  <p className="px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground uppercase">
                    {label}
                  </p>
                  {items.map((option) => {
                    const busy = section === "BUSY";
                    const name = names.teacher(option.teacherId);
                    const detail =
                      section === "AVAILABLE"
                        ? t("picker.load", {
                            from: hours(workload(option.teacherId)),
                            to: hours(workload(option.teacherId) + minutes),
                          })
                        : section === "NOT_TEACHING_LEVEL"
                          ? names.teacherLevels(option.teacherId)
                            ? t("picker.teaches", {
                                levels: names.teacherLevels(option.teacherId),
                              })
                            : t("picker.noLevels")
                          : option.reasons[0]
                            ? reasons.teacherReason(option.reasons[0])
                            : "";
                    return (
                      <button
                        key={option.teacherId}
                        type="button"
                        disabled={busy}
                        aria-label={
                          busy
                            ? t("picker.busyLabel", { name, reason: detail })
                            : undefined
                        }
                        className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:hover:bg-transparent"
                        onClick={() => choose(option.teacherId)}
                      >
                        <span
                          className={cn(
                            "font-medium",
                            busy && "text-muted-foreground",
                          )}
                        >
                          {name}
                          {option.teacherId === row.teacherId && " ✓"}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {detail}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** By teacher (§6.8): workload per teacher, busiest first. */
function ByTeacherTable({
  rows,
  draftRows: groupRows,
  names,
  draft,
  editable,
  apply,
  average,
}: {
  rows: ReturnType<typeof workloadRows>;
  draftRows: DraftRow[];
  names: Names;
  draft: DraftView;
  editable: boolean;
  apply: Apply;
  average: number;
}) {
  const t = useTranslations("generator");
  const max = Math.max(1, ...rows.map((row) => row.minutes), average);
  return (
    <TableCard>
      <Table data-testid="workload-table">
        <TableCaption className="sr-only">
          {t("draft.view.byTeacher")}
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>{t("byTeacher.teacher")}</TableHead>
            <TableHead>{t("byTeacher.levels")}</TableHead>
            <TableHead>{t("byTeacher.groups")}</TableHead>
            <TableHead>{t("byTeacher.hours")}</TableHead>
            <TableHead>{t("byTeacher.days")}</TableHead>
            <TableHead>{t("byTeacher.max")}</TableHead>
            <TableHead>
              <span className="sr-only">{t("lock.column")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const teacher = names.teachers.get(row.teacherId);
            const unlocked = groupRows.filter(
              (g) => g.teacherId === row.teacherId && !g.locked,
            );
            return (
              <TableRow key={row.teacherId}>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-2.5 rounded-full"
                      style={{ background: teacher?.color ?? "currentColor" }}
                    />
                    {names.teacher(row.teacherId)}
                  </span>
                </TableCell>
                <TableCell>
                  {names.teacherLevels(row.teacherId) || "—"}
                </TableCell>
                <TableCell>
                  {row.groups === 0 ? (
                    0
                  ) : (
                    <details>
                      <summary className="cursor-pointer">{row.groups}</summary>
                      <ul className="mt-1 text-xs text-muted-foreground">
                        {row.groupIds.map((id) => (
                          <li key={id}>
                            {names.group(id)} · {names.times(id)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="w-14 tabular-nums">
                      {t("workload.hours", { hours: hours(row.minutes) })}
                    </span>
                    <div
                      aria-hidden="true"
                      className="relative h-1.5 w-32 rounded-full bg-muted"
                    >
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${(row.minutes / max) * 100}%` }}
                      />
                      <div
                        className="absolute -top-1 h-3.5 w-px bg-foreground/60"
                        style={{ left: `${(average / max) * 100}%` }}
                      />
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  {row.weekdays.map((d) => names.weekdayShort(d)).join(", ") ||
                    "—"}
                </TableCell>
                <TableCell>
                  {row.maxMinutes !== null
                    ? t("workload.max", { hours: hours(row.maxMinutes) })
                    : ""}
                </TableCell>
                <TableCell className="text-right">
                  {editable && unlocked.length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        apply((version) =>
                          setAssignmentsLockedAction({
                            draftId: draft.id,
                            version,
                            groupIds: unlocked.map((g) => g.groupId),
                            locked: true,
                          }),
                        )
                      }
                    >
                      {t("lock.teacher", {
                        teacher: names.teacher(row.teacherId),
                      })}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableCard>
  );
}

/** Why no teacher? (§6.7): reasons per teacher, suggestions, fixes. */
function WhySheet({
  open,
  onOpenChange,
  groups,
  rows,
  names,
  draft,
  editable,
  apply,
  onReassign,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: UnassignedGroup[];
  rows: DraftRow[];
  names: Names;
  draft: DraftView;
  editable: boolean;
  apply: Apply;
  onReassign: () => void;
}) {
  const t = useTranslations("generator.unassigned");
  const reasons = useReasonMessages(names);
  const stillOpen = groups.filter((g) =>
    rows.some((row) => row.groupId === g.groupId && !row.teacherId),
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[480px] overflow-y-auto sm:max-w-[480px]">
        <SheetHeader>
          <SheetTitle>{t("title", { count: stillOpen.length })}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4">
          {stillOpen.length === 0 && (
            <p className="text-sm text-success">{t("empty")}</p>
          )}
          {stillOpen.map((group) => {
            const active = group.teachers.filter((x) => !x.archived);
            return (
              <article
                key={group.groupId}
                className="flex flex-col gap-2 rounded-lg border p-3 text-sm"
                data-testid="why-card"
              >
                <h3 className="font-medium">
                  {names.group(group.groupId)} · {names.times(group.groupId)} ·{" "}
                  {names.level(group.levelId)}
                </h3>
                {group.teachers.length === 0 ? (
                  <p>
                    {t("nobodyTeaches", { level: names.level(group.levelId) })}
                  </p>
                ) : (
                  <>
                    <p>
                      {t("intro", {
                        count: active.length,
                        level: names.level(group.levelId),
                      })}
                    </p>
                    <ul className="flex flex-col gap-1">
                      {group.teachers.map((teacher) => (
                        <li key={teacher.teacherId} className="flex gap-2">
                          <span className="w-32 shrink-0 font-medium">
                            {names.teacher(teacher.teacherId)}
                          </span>
                          <span className="text-muted-foreground">
                            {teacher.archived
                              ? t("archived")
                              : teacher.reasons
                                  .map((r) => `✗ ${reasons.teacherReason(r)}`)
                                  .join(" · ")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {group.suggestions.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <p className="font-medium">{t("suggestions")}</p>
                    <ul className="flex flex-col gap-1">
                      {group.suggestions.map((suggestion, index) => (
                        <li
                          key={index}
                          className="flex flex-wrap items-center gap-2"
                        >
                          <span>
                            • {reasons.suggestion(suggestion, group.levelId)}
                          </span>
                          {editable &&
                            suggestion.kind === "SWAP" &&
                            !suggestion.otherLocked && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  apply(
                                    (version) =>
                                      saveAssignmentAction({
                                        draftId: draft.id,
                                        version,
                                        groupId: suggestion.otherGroupId,
                                        teacherId: suggestion.otherTeacherId,
                                      }),
                                    () =>
                                      apply((version) =>
                                        saveAssignmentAction({
                                          draftId: draft.id,
                                          version,
                                          groupId: group.groupId,
                                          teacherId: suggestion.teacherId,
                                        }),
                                      ),
                                  )
                                }
                              >
                                {t("apply")}
                              </Button>
                            )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex flex-wrap gap-3">
                  <Link
                    href={`/admin/groups/${group.groupId}?tab=details`}
                    target="_blank"
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t("editTimes")}
                  </Link>
                  <Link
                    href="/admin/teachers"
                    target="_blank"
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t("teacherLevels")}
                  </Link>
                </div>
              </article>
            );
          })}
          <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
            <span className="text-muted-foreground">{t("footer")}</span>
            {editable && (
              <Button size="sm" variant="outline" onClick={onReassign}>
                {t("reassign")}
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
