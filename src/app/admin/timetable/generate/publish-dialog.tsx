"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { useMessage } from "@/components/admin/use-message";
import {
  useConflictMessage,
  useDateFormat,
} from "@/components/timetable/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { GeneratorPageData } from "@/server/timetable/generator-page";
import type {
  ApplyIssue,
  DraftView,
  PreviewResult,
} from "@/server/timetable/generator-service";
import {
  acknowledgedKeys,
  type DraftRow,
  hours,
} from "@/server/timetable/generator-view";

import { applyDraftAction, previewApplyAction } from "../generator-actions";
import { SeverityIcon } from "../edit/conflict-list";
import type { Names } from "./use-names";

/**
 * Publish (§7): previews what applying does, asks to acknowledge the
 * overridable issues, then applies under the timetable lock. A draft term
 * can also be saved to the editor only.
 */
export function PublishDialog({
  open,
  onOpenChange,
  data,
  names,
  draft,
  rows,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: GeneratorPageData;
  names: Names;
  draft: DraftView;
  rows: DraftRow[];
}) {
  const t = useTranslations("generator.publish");
  const tc = useTranslations("common");
  const render = useMessage();
  const router = useRouter();
  const formatDate = useDateFormat();
  const term = data.term!;
  const replace = draft.mode === "REPLACE";
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [understood, setUnderstood] = useState(false);
  const [blocking, setBlocking] = useState<ApplyIssue[] | null>(null);
  const [pending, startTransition] = useTransition();
  const unassigned = rows.filter((row) => !row.teacherId).length;
  // Groups with no live teacher yet that get one from the draft.
  const starting = rows.filter(
    (row) => row.teacherId && row.currentTeacherId === null,
  ).length;

  useEffect(() => {
    let cancelled = false;
    previewApplyAction({ draftId: draft.id, publish: replace }).then(
      (result) => {
        if (cancelled) return;
        if (!result.ok) {
          setError(result.formError ? render(result.formError) : t("failed"));
          return;
        }
        setPreview(result.data);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [draft.id, draft.version, replace, render, t]);

  const issues = preview?.issues ?? [];
  const blockers = blocking ?? preview?.blocking ?? [];
  const allTicked = issues.every((issue) => ticked.has(issue.key));
  const ready =
    preview !== null &&
    blockers.length === 0 &&
    allTicked &&
    (replace || understood);

  function apply(publish: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await applyDraftAction({
        draftId: draft.id,
        version: draft.version,
        acknowledgedConflictKeys: acknowledgedKeys(issues, ticked),
        publish,
      });
      if (!result.ok) {
        setError(result.formError ? render(result.formError) : t("failed"));
        return;
      }
      const outcome = result.data;
      if (!outcome.ok) {
        if (outcome.blocking.length > 0) setBlocking(outcome.blocking);
        if (outcome.unacknowledged.length > 0) {
          setError(
            render({
              key: "scheduling.generator.errors.UNACKNOWLEDGED_CONFLICTS",
            }),
          );
        }
        return;
      }
      toast.success(
        outcome.published
          ? t("done", {
              term: term.name,
              count: outcome.counts.lessons.created,
            })
          : replace
            ? t("savedToEditor", { count: outcome.counts.slots.created })
            : t("applied", {
                changed: outcome.counts.groups.changed,
                lessons: outcome.counts.lessons.repointed,
              }),
      );
      onOpenChange(false);
      router.push(`/admin/timetable/edit?term=${term.id}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("title", { term: term.name })}</DialogTitle>
          <DialogDescription>
            {replace
              ? t("descriptionDraft")
              : t("fromDate", {
                  date: formatDate(draft.effectiveFrom!, "long"),
                })}
          </DialogDescription>
        </DialogHeader>
        {preview === null && !error ? (
          <p className="flex items-center gap-2 text-sm" role="status">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            {t("previewing")}
          </p>
        ) : preview ? (
          <div
            className="flex flex-col gap-3 text-sm"
            data-testid="publish-summary"
          >
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {replace ? (
                <>
                  <li>
                    {t("groups", {
                      groups: preview.counts.groups.assigned,
                      slots: preview.counts.slots.created,
                    })}
                  </li>
                  {preview.counts.slots.deleted > 0 && (
                    <li>
                      {t("replaces", { count: preview.counts.slots.deleted })}
                    </li>
                  )}
                  <li>
                    {t("range", {
                      start: formatDate(term.startDate, "short"),
                      end: formatDate(term.endDate, "short"),
                    })}
                  </li>
                </>
              ) : (
                <>
                  <li>
                    {t("changes", {
                      changed: preview.counts.groups.changed,
                      new: starting,
                    })}
                  </li>
                  <li>
                    {t("lessons", {
                      moved: preview.counts.lessons.repointed,
                      created: preview.counts.lessons.created,
                    })}
                  </li>
                  <li>
                    {t("people", {
                      teachers: preview.teacherIds.length,
                      students: preview.studentCount,
                    })}
                  </li>
                  {preview.replacementBookings > 0 && (
                    <li>
                      {t("bookings", { count: preview.replacementBookings })}
                    </li>
                  )}
                </>
              )}
              <li>
                {t("workload", {
                  min: hours(preview.counts.workloadRange.minMinutes),
                  max: hours(preview.counts.workloadRange.maxMinutes),
                })}
              </li>
              {unassigned > 0 && (
                <li className="text-warning">
                  {t("unassigned", { count: unassigned })}
                </li>
              )}
            </ul>
            {blockers.length > 0 && (
              <Alert variant="destructive">
                <AlertDescription className="flex flex-col gap-1">
                  <span className="font-medium">
                    {t("blocked", { count: blockers.length })}
                  </span>
                  <IssueList issues={blockers} names={names} />
                </AlertDescription>
              </Alert>
            )}
            {issues.length > 0 && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 font-medium">
                  {t("warnings", { count: issues.length })}
                </legend>
                <ul className="flex flex-col gap-2">
                  {issues.map((issue) => (
                    <li
                      key={issue.key}
                      className="flex flex-col gap-1 rounded-lg border border-warning-border bg-warning-surface p-2"
                    >
                      <IssueText issue={issue} names={names} />
                      <label className="flex items-center gap-2 pl-6 font-medium">
                        <Checkbox
                          checked={ticked.has(issue.key)}
                          onCheckedChange={(checked) =>
                            setTicked((current) => {
                              const next = new Set(current);
                              if (checked === true) next.add(issue.key);
                              else next.delete(issue.key);
                              return next;
                            })
                          }
                        />
                        {t("acknowledge")}
                      </label>
                    </li>
                  ))}
                </ul>
                {issues.length > 1 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-fit"
                    onClick={() =>
                      setTicked(new Set(issues.map((issue) => issue.key)))
                    }
                  >
                    {t("acknowledgeAll")}
                  </Button>
                )}
              </fieldset>
            )}
            {!replace && (
              <label className="flex items-start gap-2 font-medium">
                <Checkbox
                  checked={understood}
                  onCheckedChange={(checked) => setUnderstood(checked === true)}
                />
                {t("understand", {
                  date: formatDate(draft.effectiveFrom!, "short"),
                })}
              </label>
            )}
          </div>
        ) : null}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {tc("cancel")}
          </Button>
          {replace && (
            <Button
              variant="outline"
              disabled={!ready || pending}
              onClick={() => apply(false)}
            >
              {t("toEditor")}
            </Button>
          )}
          <Button disabled={!ready || pending} onClick={() => apply(replace)}>
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {pending ? t("running") : replace ? t("confirm") : t("apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IssueText({ issue, names }: { issue: ApplyIssue; names: Names }) {
  const t = useTranslations("generator.publish");
  const tn = useTranslations("scheduling.generator.notices");
  const conflictMessage = useConflictMessage();
  if (issue.kind === "maxHours") {
    return (
      <p className="flex items-start gap-2">
        <SeverityIcon severity="overridable" />
        {tn("OVER_MAX_HOURS", {
          teacher: names.teacher(issue.teacherId),
          minutes: issue.minutes,
          maxMinutes: issue.maxMinutes,
        })}
      </p>
    );
  }
  return (
    <p className="flex items-start gap-2">
      <SeverityIcon severity={issue.conflict.severity} />
      <span>
        {issue.kind === "slot" && (
          <span className="font-medium">{names.group(issue.groupId)}: </span>
        )}
        {issue.kind === "lesson" && (
          <span className="font-medium">{t("lessonIssue")} </span>
        )}
        {conflictMessage(issue.conflict)}
      </span>
    </p>
  );
}

function IssueList({ issues, names }: { issues: ApplyIssue[]; names: Names }) {
  return (
    <ul className="flex flex-col gap-1">
      {issues.map((issue) => (
        <li key={issue.key}>
          <IssueText issue={issue} names={names} />
        </li>
      ))}
    </ul>
  );
}
