"use client";

import { Loader2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/admin/dialogs";
import { useMessage } from "@/components/admin/use-message";
import {
  formatMinutes,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Message } from "@/server/admin/result";
import { issueRows, publishSummary } from "@/server/timetable/editor";
import type { EditorData, EditorSlot } from "@/server/timetable/editor-data";
import type { LessonChanges } from "@/server/timetable/service";

import {
  deleteSlotAction,
  endSlotAction,
  publishTermAction,
  regenerateLessonsAction,
} from "../actions";
import { SeverityBadge, SeverityIcon } from "./conflict-list";

/** "9 lessons created, 8 future lessons removed, …" (timetable.md §5.10). */
export function useLessonResult() {
  const t = useTranslations("timetable.result");
  const format = useFormatter();
  return (changes: LessonChanges) => {
    const parts = (["created", "removed", "cancelled"] as const)
      .filter((part) => changes[part] > 0)
      .map((part) => t(part, { count: changes[part] }));
    if (parts.length === 0) return t("none");
    const joined = format.list(parts, { type: "unit" });
    return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
  };
}

function useSlotSummary() {
  const tc = useTranslations("common");
  return (slot: EditorSlot) =>
    `${tc(`weekdayShort.${slot.weekday}` as "weekdayShort.1")} ${formatMinutes(slot.startMinute)}–${formatMinutes(slot.endMinute)}`;
}

/** Issues panel (§5.6): every slot with conflicts or unacknowledged warnings. */
export function IssuesSheet({
  open,
  onOpenChange,
  data,
  onShow,
  onEdit,
  includeAcknowledged,
  onIncludeAcknowledged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: EditorData;
  onShow: (slot: EditorSlot) => void;
  onEdit: (slot: EditorSlot) => void;
  includeAcknowledged: boolean;
  onIncludeAcknowledged: (value: boolean) => void;
}) {
  const t = useTranslations("timetable");
  const tc = useTranslations("common");
  const message = useConflictMessage();
  const id = useId();
  const rows = issueRows(
    data.issues,
    (slotId) => data.acknowledgements[slotId]?.keys ?? [],
    includeAcknowledged,
  );
  const slots = new Map(data.slots.map((s) => [s.id, s]));
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        closeLabel={tc("close")}
        className="w-full overflow-y-auto sm:max-w-[480px]"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>
            {t("issues.title", { term: data.term?.name ?? "" })}
          </SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4 pb-6">
          <label htmlFor={id} className="flex items-center gap-2 text-sm">
            <Checkbox
              id={id}
              checked={includeAcknowledged}
              onCheckedChange={(checked) =>
                onIncludeAcknowledged(checked === true)
              }
            />
            {t("issues.includeAcknowledged")}
          </label>
          {rows.length === 0 ? (
            <p className="text-muted-foreground">{t("issues.empty")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((row) => {
                const slot = slots.get(row.slotId);
                if (!slot) return null;
                return (
                  <li
                    key={`${row.slotId}-${row.conflict.key}`}
                    className="flex flex-col gap-1.5 rounded-lg border p-3"
                  >
                    <div className="flex items-start gap-2">
                      <SeverityIcon severity={row.conflict.severity} />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <SeverityBadge severity={row.conflict.severity} />
                          <span className="text-sm font-medium">
                            {t("issues.slotSummary", {
                              group: slot.groupName,
                              weekday: tc(
                                `weekdayShort.${slot.weekday}` as "weekdayShort.1",
                              ),
                              time: formatMinutes(slot.startMinute),
                            })}
                          </span>
                        </span>
                        <p className="text-sm">{message(row.conflict)}</p>
                      </div>
                    </div>
                    <div className="flex gap-2 pl-6">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onShow(slot)}
                      >
                        {t("issues.show")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onEdit(slot)}
                      >
                        {tc("edit")}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Publish dialog (§5.7). */
export function PublishDialog({
  open,
  onOpenChange,
  data,
  onShowIssues,
  onPublished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: EditorData;
  onShowIssues: (includeAcknowledged: boolean) => void;
  onPublished: () => void;
}) {
  const t = useTranslations("timetable.publish");
  const tc = useTranslations("common");
  const formatDate = useDateFormat();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState<{
    count: number;
    slotIds: string[];
  } | null>(null);
  const term = data.term!;
  const summary = publishSummary(
    term,
    data.slots.length,
    data.issues,
    data.today,
  );
  const blockingCount = refused?.count ?? summary.blockingCount;
  const blockingSlots = refused?.slotIds ?? summary.blockingSlots;
  const slots = new Map(data.slots.map((s) => [s.id, s]));
  const slotSummary = useSlotSummary();

  function publish() {
    setFailed(false);
    startTransition(async () => {
      try {
        const result = await publishTermAction(term.id);
        if (!result.ok) {
          setFailed(true);
          return;
        }
        if (!result.data.published) {
          setRefused({
            count: result.data.conflicts,
            slotIds: result.data.blockingSlotIds,
          });
          return;
        }
        toast.success(
          t("done", { term: term.name, count: result.data.created }),
        );
        onOpenChange(false);
        onPublished();
      } catch {
        setFailed(true);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title", { term: term.name })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          <li>{t("slots", { count: summary.slots })}</li>
          <li>
            {t("range", {
              start: formatDate(summary.rangeStart, "short"),
              end: formatDate(summary.rangeEnd, "short"),
            })}
          </li>
          {summary.warnings > 0 && (
            <li>
              {t("warnings", { count: summary.warnings })}{" "}
              <button
                type="button"
                className="font-medium text-primary underline-offset-4 hover:underline"
                onClick={() => onShowIssues(true)}
              >
                {t("review")}
              </button>
            </li>
          )}
        </ul>
        {blockingCount > 0 && (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-col gap-1">
              <span className="font-medium">
                {t("blocked", { count: blockingCount })}
              </span>
              <ul className="list-disc pl-5">
                {blockingSlots.map((slotId) => {
                  const slot = slots.get(slotId);
                  return slot ? (
                    <li key={slotId}>
                      {slot.groupName} · {slotSummary(slot)}
                    </li>
                  ) : null;
                })}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {failed && (
          <Alert variant="destructive">
            <AlertDescription>{t("failed")}</AlertDescription>
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
          {blockingCount > 0 ? (
            <Button onClick={() => onShowIssues(false)}>
              {t("showIssues")}
            </Button>
          ) : (
            <Button onClick={publish} disabled={pending}>
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {pending ? t("running") : t("confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** End a slot of a published term (§5.5). */
export function EndSlotDialog({
  slot,
  data,
  defaultDate,
  onOpenChange,
  onDone,
}: {
  slot: EditorSlot | null;
  data: EditorData;
  defaultDate: string;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const t = useTranslations("timetable");
  const tc = useTranslations("common");
  const formatDate = useDateFormat();
  const lessonResult = useLessonResult();
  const id = useId();
  const [date, setDate] = useState(defaultDate);
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (slot && shownFor !== slot.id) {
    setShownFor(slot.id);
    setDate(defaultDate);
  }
  if (!slot) return null;
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={t("end.title", {
        group: slot.groupName,
        weekday: tc(`weekday.${slot.weekday}` as "weekday.1"),
      })}
      description={
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5 text-foreground">
            <Label htmlFor={id}>{t("end.lastLesson")}</Label>
            <Input
              id={id}
              type="date"
              value={date}
              min={data.today}
              max={data.term?.endDate}
              onChange={(e) => setDate(e.target.value || defaultDate)}
            />
          </div>
          <p>{t("end.description", { date: formatDate(date, "short") })}</p>
          <p>{t("end.hint")}</p>
        </div>
      }
      confirmLabel={t("end.confirm")}
      destructive
      run={async () => {
        const result = await endSlotAction({ slotId: slot.id, lastDate: date });
        if (result.ok) {
          toast.success(
            t("toast.slotEndedResult", {
              date: formatDate(date, "short"),
              result: lessonResult(result.data.lessons),
            }),
          );
        }
        return result.ok ? { ok: true, data: undefined } : result;
      }}
      onDone={onDone}
    />
  );
}

/** Delete a slot that never took place (§5.5); offers End instead on refusal. */
export function DeleteSlotDialog({
  slot,
  published,
  onOpenChange,
  onDone,
  onEndInstead,
}: {
  slot: EditorSlot | null;
  published: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  onEndInstead: (slot: EditorSlot) => void;
}) {
  const t = useTranslations("timetable");
  const tc = useTranslations("common");
  const render = useMessage();
  const lessonResult = useLessonResult();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<Message | null>(null);
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (slot && shownFor !== slot.id) {
    setShownFor(slot.id);
    setError(null);
  }
  if (!slot) return null;
  const hasLessons = error?.key === "scheduling.errors.SLOT_HAS_LESSONS";
  return (
    <Dialog open onOpenChange={(open) => !pending && onOpenChange(open)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("delete.title")}</DialogTitle>
          <DialogDescription>
            {t("delete.description", {
              group: slot.groupName,
              weekday: tc(`weekday.${slot.weekday}` as "weekday.1"),
              time: `${formatMinutes(slot.startMinute)}–${formatMinutes(slot.endMinute)}`,
            })}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{render(error)}</AlertDescription>
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
          {hasLessons && published ? (
            <Button onClick={() => onEndInstead(slot)}>
              {t("slot.endInstead")}
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await deleteSlotAction(slot.id);
                  if (!result.ok) {
                    setError(
                      result.formError ?? { key: "common.error.unexpected" },
                    );
                    return;
                  }
                  const changed =
                    result.data.created +
                      result.data.removed +
                      result.data.cancelled >
                    0;
                  toast.success(
                    changed
                      ? `${t("toast.slotDeleted")}. ${lessonResult(result.data)}`
                      : t("toast.slotDeleted"),
                  );
                  onDone();
                })
              }
            >
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {t("slot.delete")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Check & regenerate lessons (§5.8). */
export function RegenerateDialog({
  open,
  termId,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  termId: string;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const t = useTranslations("timetable");
  const lessonResult = useLessonResult();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("editor.regenerate")}
      description={t("regenerate.description")}
      confirmLabel={t("regenerate.run")}
      run={async () => {
        const result = await regenerateLessonsAction(termId);
        if (result.ok) {
          toast.success(
            t("toast.regenerated", { result: lessonResult(result.data) }),
          );
        }
        return result.ok ? { ok: true, data: undefined } : result;
      }}
      onDone={onDone}
    />
  );
}
