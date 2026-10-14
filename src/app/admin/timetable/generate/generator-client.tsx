"use client";

import { Loader2, MoreHorizontal, WandSparkles } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/admin/dialogs";
import { useMessage } from "@/components/admin/use-message";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DraftMode, Readiness } from "@/server/scheduling/generator";
import type { GeneratorPageData } from "@/server/timetable/generator-page";
import type { DraftView, RunView } from "@/server/timetable/generator-service";
import { readinessCounts } from "@/server/timetable/generator-view";

import {
  cancelRunAction,
  checkReadinessAction,
  discardDraftAction,
  getDraftAction,
  getRunAction,
  startRunAction,
} from "../generator-actions";
import { DraftTab } from "./draft-tab";
import { GroupsTab } from "./groups-tab";
import { useNames } from "./use-names";

type Tab = "groups" | "draft";

type RunProgress = { phase?: string; assigned?: number; total?: number };

const POLL_MS = 700;

export function GeneratorClient({
  data,
  tab: initialTab,
}: {
  data: GeneratorPageData;
  tab: Tab;
}) {
  const t = useTranslations("generator");
  const tc = useTranslations("common");
  const render = useMessage();
  const router = useRouter();
  const pathname = usePathname();
  const names = useNames(data);
  const term = data.term!;
  const published = term.publishedAt !== null;
  const [tab, setTab] = useState<Tab>(initialTab);
  const [assignOpen, setAssignOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [draft, setDraft] = useState<DraftView | null>(data.draft);
  const [run, setRun] = useState<RunView | null>(
    data.draft?.latestRun?.status === "RUNNING" ? data.draft.latestRun : null,
  );
  const readiness = data.readiness!;
  const counts = readinessCounts(readiness);

  // A fresh server render (router.refresh) brings a newer draft.
  const [serverDraft, setServerDraft] = useState(data.draft);
  if (serverDraft !== data.draft) {
    setServerDraft(data.draft);
    setDraft(data.draft);
  }

  function go(next: Tab) {
    setTab(next);
    const search = new URLSearchParams({ term: term.id });
    if (next === "draft") search.set("tab", "draft");
    router.replace(`${pathname}?${search}`, { scroll: false });
  }

  // Polls the run until it ends (§6.4); only completion is announced.
  useEffect(() => {
    if (!run || run.status !== "RUNNING") return;
    const timer = setTimeout(async () => {
      const result = await getRunAction(run.id);
      if (!result.ok) {
        setRun(null);
        return;
      }
      const next = result.data;
      if (next.status === "RUNNING") {
        setRun(next);
        return;
      }
      setRun(null);
      if (next.status === "DONE") {
        const fresh = await getDraftAction(term.id);
        if (fresh.ok) setDraft(fresh.data);
        const summary = next.result as {
          assigned: number;
          unassigned: number;
        } | null;
        if (summary) {
          toast.success(
            t("run.done", {
              assigned: summary.assigned,
              total: summary.assigned + summary.unassigned,
            }),
          );
        }
        go("draft");
      } else if (next.status === "FAILED") {
        toast.error(
          next.errorCode && next.errorCode !== "INTERNAL_ERROR"
            ? render({ key: `scheduling.generator.errors.${next.errorCode}` })
            : t("run.failed"),
        );
      } else {
        toast(t("run.cancelled"));
      }
      router.refresh();
    }, POLL_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const assignedCount =
    draft?.assignments.filter((a) => a.teacherId !== null).length ?? 0;
  const hasRun = draft !== null && draft.generatedAt !== null;
  const draftStatus = run
    ? t("tabs.draftRunning")
    : !hasRun
      ? t("tabs.draftNone")
      : draft!.outOfDate
        ? t("tabs.draftStale")
        : t("tabs.draftStatus", {
            assigned: assignedCount,
            total: draft!.assignments.length,
          });
  const progress = (run?.progress ?? {}) as RunProgress;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold">{t("title")}</h1>
        <NativeSelect
          aria-label={t("term")}
          value={term.id}
          onChange={(e) =>
            router.push(
              `${pathname}?term=${encodeURIComponent(e.target.value)}`,
            )
          }
        >
          {data.terms.map((option) => (
            <NativeSelectOption key={option.id} value={option.id}>
              {option.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Badge variant={published ? "secondary" : "outline"}>
          {published ? t("termPublished") : t("termDraft")}
        </Badge>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="icon"
                aria-label={t("actions.more")}
              />
            }
          >
            <MoreHorizontal aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              render={<Link href={`/admin/timetable/edit?term=${term.id}`} />}
            >
              {t("actions.openEditor")}
            </DropdownMenuItem>
            {draft && (
              <DropdownMenuItem
                variant="destructive"
                disabled={run !== null}
                onClick={() => setDiscardOpen(true)}
              >
                {t("actions.discardDraft")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {!data.termEnded && (
          <Button onClick={() => setAssignOpen(true)} disabled={run !== null}>
            <WandSparkles aria-hidden="true" />
            {hasRun ? t("actions.reassign") : t("actions.assign")}
          </Button>
        )}
      </div>

      {data.termEnded && (
        <Alert>
          <AlertDescription>{t("termEnded")}</AlertDescription>
        </Alert>
      )}
      {data.teachers.every((teacher) => teacher.levelIds.length === 0) && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {t("empty.noTeachers")}
            <Link
              href="/admin/teachers"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t("empty.goToTeachers")}
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {run && (
        <div
          className="flex flex-col gap-2 rounded-lg border p-4"
          data-testid="run-progress"
        >
          <div className="flex items-center gap-2 text-sm">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            <span>
              {progress.total
                ? t("run.running", {
                    assigned: progress.assigned ?? 0,
                    total: progress.total,
                  })
                : t("tabs.draftRunning")}
              {run.startedById && data.latestRunBy && (
                <span className="ml-2 text-muted-foreground">
                  {t("run.startedBy", { name: data.latestRunBy })}
                </span>
              )}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={async () => {
                const result = await cancelRunAction(run.id);
                if (!result.ok && result.formError) {
                  toast.error(render(result.formError));
                }
              }}
            >
              {tc("cancel")}
            </Button>
          </div>
          <div
            role="progressbar"
            aria-label={t("tabs.draftRunning")}
            aria-valuemin={0}
            aria-valuemax={progress.total ?? 0}
            aria-valuenow={progress.assigned ?? 0}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary transition-[width]"
              style={{
                width: progress.total
                  ? `${Math.round(((progress.assigned ?? 0) / progress.total) * 100)}%`
                  : "5%",
              }}
            />
          </div>
        </div>
      )}

      <Tabs value={tab} onValueChange={(next: Tab) => go(next)}>
        <TabsList aria-label={t("title")}>
          <TabsTrigger value="groups">
            {t("tabs.groups")}
            <span className="ml-1 text-xs text-muted-foreground">
              {t("tabs.groupsStatus", {
                ready: counts.ready,
                attention: counts.attention,
              })}
            </span>
          </TabsTrigger>
          <TabsTrigger value="draft">
            {t("tabs.draft")}
            <span className="ml-1 text-xs text-muted-foreground">
              {draftStatus}
            </span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="groups" className="pt-4">
          <GroupsTab data={data} names={names} readOnly={data.termEnded} />
        </TabsContent>
        <TabsContent value="draft" className="pt-4">
          <DraftTab
            data={data}
            names={names}
            draft={hasRun ? draft : null}
            running={run !== null}
            readOnly={data.termEnded}
            onDraft={setDraft}
            onAssign={() => setAssignOpen(true)}
          />
        </TabsContent>
      </Tabs>

      <AssignDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        data={data}
        draft={draft}
        initial={readiness}
        onStarted={(started) => {
          setAssignOpen(false);
          setRun({
            id: started.runId,
            termId: term.id,
            draftId: started.draftId,
            status: "RUNNING",
            cancelRequested: false,
            progress: null,
            result: null,
            errorCode: null,
            startedById: null,
            startedAt: new Date(),
            finishedAt: null,
          });
        }}
      />
      {draft && (
        <ConfirmDialog
          open={discardOpen}
          onOpenChange={setDiscardOpen}
          title={t("discard.title", { term: term.name })}
          description={t("discard.description")}
          confirmLabel={t("discard.confirm")}
          destructive
          run={() => discardDraftAction(draft.id)}
          onDone={() => {
            setDraft(null);
            toast.success(t("discard.done"));
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/** "Assign teachers for {term}" (§6.3): mode, date, keep or reassign. */
function AssignDialog({
  open,
  onOpenChange,
  data,
  draft,
  initial,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: GeneratorPageData;
  draft: DraftView | null;
  initial: Readiness;
  onStarted: (started: { runId: string; draftId: string }) => void;
}) {
  const t = useTranslations("generator.assign");
  const tc = useTranslations("common");
  const render = useMessage();
  const term = data.term!;
  const published = term.publishedAt !== null;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fillMode, setFillMode] = useState<"FILL" | "REPLAN_FROM">(
    draft?.mode === "REPLAN_FROM" ? "REPLAN_FROM" : "FILL",
  );
  const [from, setFrom] = useState(
    draft?.effectiveFrom ?? data.defaultEffectiveFrom,
  );
  const [keepCurrent, setKeepCurrent] = useState(true);
  const [readiness, setReadiness] = useState(initial);
  const mode: DraftMode = published ? fillMode : "REPLACE";
  const counts = readinessCounts(readiness);
  const activeTeachers = data.teachers.filter(
    (teacher) => !teacher.archived && teacher.levelIds.length > 0,
  ).length;
  const sameDraft =
    draft !== null &&
    draft.mode === mode &&
    (mode === "REPLACE" || draft.effectiveFrom === from);
  const locked = sameDraft
    ? draft!.assignments.filter((a) => a.locked).length
    : 0;

  // Readiness depends on the mode and date (FILL keeps running groups).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    checkReadinessAction({
      termId: term.id,
      mode,
      ...(mode === "REPLACE" ? {} : { effectiveFrom: from }),
    }).then((result) => {
      if (!cancelled && result.ok) setReadiness(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [open, mode, from, term.id]);

  function start() {
    setError(null);
    startTransition(async () => {
      const result = await startRunAction({
        termId: term.id,
        mode,
        ...(mode === "REPLACE"
          ? draft || data.termSlotCount === 0
            ? {}
            : { keepCurrentTeachers: keepCurrent }
          : { effectiveFrom: from }),
      });
      if (!result.ok) {
        setError(result.formError ? render(result.formError) : t("failed"));
        return;
      }
      onStarted(result.data);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title", { term: term.name })}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 text-sm">
          {counts.included === 0 ? (
            <Alert>
              <AlertDescription>{t("nothing")}</AlertDescription>
            </Alert>
          ) : (
            <p>
              {t("included", {
                groups: counts.included,
                teachers: activeTeachers,
              })}
            </p>
          )}
          {counts.notReady > 0 && (
            <p className="text-warning">
              {t("skipped", { count: counts.notReady })}
            </p>
          )}
          {!published && !draft && data.termSlotCount > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 font-medium">{t("existing")}</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="keep"
                  className="size-4 accent-primary"
                  checked={keepCurrent}
                  onChange={() => setKeepCurrent(true)}
                />
                {t("keepCurrent")}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="keep"
                  className="size-4 accent-primary"
                  checked={!keepCurrent}
                  onChange={() => setKeepCurrent(false)}
                />
                {t("reassignAll")}
              </label>
            </fieldset>
          )}
          {published && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="assign-from">{t("fromDate")}</Label>
                <Input
                  id="assign-from"
                  type="date"
                  className="w-fit"
                  min={
                    data.today < term.startDate ? term.startDate : data.today
                  }
                  max={term.endDate}
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  aria-describedby="assign-from-hint"
                />
                <p id="assign-from-hint" className="text-muted-foreground">
                  {t("fromDateHint")}
                </p>
              </div>
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">{t("modeLegend")}</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="mode"
                    className="size-4 accent-primary"
                    checked={fillMode === "FILL"}
                    onChange={() => setFillMode("FILL")}
                  />
                  {t("onlyUnassigned")}
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="mode"
                    className="size-4 accent-primary"
                    checked={fillMode === "REPLAN_FROM"}
                    onChange={() => setFillMode("REPLAN_FROM")}
                  />
                  {t("reconsiderAll")}
                </label>
              </fieldset>
            </>
          )}
          {sameDraft && draft!.generatedAt && (
            <p>
              {t("keepsLocked", {
                locked,
                unlocked: draft!.assignments.length - locked,
              })}
            </p>
          )}
          {draft && !sameDraft && (
            <p className="text-warning">{t("replacesDraft")}</p>
          )}
          <p className="text-muted-foreground">{t("preference")}</p>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {tc("cancel")}
          </Button>
          <Button onClick={start} disabled={pending || counts.included === 0}>
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
