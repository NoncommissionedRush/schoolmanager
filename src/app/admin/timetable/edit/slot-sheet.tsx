"use client";

import { CircleCheck, Loader2, MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import { useMessage } from "@/components/admin/use-message";
import { formatMinutes, useDateFormat } from "@/components/timetable/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { Message } from "@/server/admin/result";
import type { Conflict } from "@/server/scheduling";
import {
  canSaveSlot,
  defaultTeacherForGroup,
  occurrenceSummary,
} from "@/server/timetable/editor";
import type { EditorData, EditorSlot } from "@/server/timetable/editor-data";

import {
  saveSlotAction,
  type SaveSlotOutcome,
  validateSlotAction,
} from "../actions";
import { ConflictRow } from "./conflict-list";

export type SlotDraft = {
  groupId: string;
  teacherId: string;
  roomId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
};

export type SheetState =
  | { mode: "new"; draft: SlotDraft }
  | { mode: "edit"; slot: EditorSlot; draft?: SlotDraft };

const STEP = 15;
const TIMES = Array.from({ length: (24 * 60) / STEP + 1 }, (_, i) => i * STEP);

/**
 * Slot sheet (timetable.md §5.4): fields, live check with conflicts and
 * warnings, per-warning acknowledgement and save. The server re-checks on
 * save; a refusal shows the fresh list and never retries automatically.
 */
export function SlotSheet({
  state,
  data,
  onClose,
  onSaved,
  onShowSlot,
  onEnd,
  onDelete,
  onDuplicate,
}: {
  state: SheetState | null;
  data: EditorData;
  onClose: () => void;
  onSaved: (
    result: Extract<SaveSlotOutcome, { saved: true }>,
    draft: SlotDraft,
  ) => void;
  onShowSlot: (slotId: string) => void;
  onEnd: (slot: EditorSlot) => void;
  onDelete: (slot: EditorSlot) => void;
  onDuplicate: (draft: SlotDraft) => void;
}) {
  const t = useTranslations("timetable");
  const tc = useTranslations("common");
  return (
    <Sheet open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        closeLabel={tc("close")}
        className="w-full overflow-y-auto sm:max-w-[420px]"
      >
        {state && (
          <SlotForm
            // Remount per slot so every opening starts from its values.
            key={
              state.mode === "edit"
                ? `edit-${state.slot.id}`
                : `new-${JSON.stringify(state.draft)}`
            }
            state={state}
            data={data}
            onClose={onClose}
            onSaved={onSaved}
            onShowSlot={onShowSlot}
            onEnd={onEnd}
            onDelete={onDelete}
            onDuplicate={onDuplicate}
            title={
              state.mode === "new" ? t("slot.newTitle") : t("slot.editTitle")
            }
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function SlotForm({
  state,
  data,
  title,
  onClose,
  onSaved,
  onShowSlot,
  onEnd,
  onDelete,
  onDuplicate,
}: {
  state: SheetState;
  data: EditorData;
  title: string;
  onClose: () => void;
  onSaved: (
    result: Extract<SaveSlotOutcome, { saved: true }>,
    draft: SlotDraft,
  ) => void;
  onShowSlot: (slotId: string) => void;
  onEnd: (slot: EditorSlot) => void;
  onDelete: (slot: EditorSlot) => void;
  onDuplicate: (draft: SlotDraft) => void;
}) {
  const t = useTranslations("timetable");
  const tc = useTranslations("common");
  const render = useMessage();
  const formatDate = useDateFormat();
  const id = useId();
  const term = data.term!;
  const published = term.publishedAt !== null;
  const editing = state.mode === "edit" ? state.slot : null;

  const [draft, setDraft] = useState<SlotDraft>(() =>
    state.mode === "new"
      ? state.draft
      : (state.draft ?? {
          groupId: state.slot.groupId,
          teacherId: state.slot.teacherId,
          roomId: state.slot.roomId ?? "",
          weekday: state.slot.weekday,
          startMinute: state.slot.startMinute,
          endMinute: state.slot.endMinute,
        }),
  );
  const minEffective =
    data.today > term.startDate ? data.today : term.startDate;
  const [effectiveFrom, setEffectiveFrom] = useState(minEffective);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [checking, setChecking] = useState(false);
  // The request the shown check result belongs to; Save waits for a match.
  const [checkedKey, setCheckedKey] = useState<string | null>(null);
  const previousKeys = editing
    ? (data.acknowledgements[editing.id]?.keys ?? [])
    : [];
  const [acked, setAcked] = useState<Set<string>>(() => new Set(previousKeys));
  const [reason, setReason] = useState("");
  const [newKeys, setNewKeys] = useState<Set<string>>(new Set());
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [submitError, setSubmitError] = useState<"fixFirst" | "tickAll" | null>(
    null,
  );
  const [pending, startTransition] = useTransition();
  const checkHeading = useRef<HTMLHeadingElement>(null);
  const changedAlert = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLSelectElement>(null);
  const roomRef = useRef<HTMLSelectElement>(null);
  const requestId = useRef(0);

  const complete =
    draft.groupId !== "" &&
    draft.teacherId !== "" &&
    draft.startMinute < draft.endMinute;
  const request = {
    ...(editing && { slotId: editing.id }),
    slot: {
      termId: term.id,
      groupId: draft.groupId,
      teacherId: draft.teacherId,
      roomId: draft.roomId || null,
      weekday: draft.weekday,
      startMinute: draft.startMinute,
      endMinute: draft.endMinute,
    },
    ...(published && { effectiveFrom }),
  };
  const requestKey = JSON.stringify(request);

  // Live check, debounced 400 ms after the last change (§5.4).
  useEffect(() => {
    if (!complete) return;
    const current = ++requestId.current;
    const timer = setTimeout(async () => {
      setChecking(true);
      try {
        const result = await validateSlotAction(JSON.parse(requestKey));
        if (current !== requestId.current) return;
        if (result.ok) {
          setConflicts(result.data);
          setError(null);
        } else {
          // No list to act on: Save may still go, the server re-checks.
          setConflicts(null);
          setError(result.formError ?? { key: "common.error.unexpected" });
        }
        setCheckedKey(requestKey);
      } catch {
        if (current === requestId.current) {
          setConflicts(null);
          setCheckedKey(requestKey);
          setError({ key: "common.error.network" });
        }
      } finally {
        if (current === requestId.current) setChecking(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [requestKey, complete]);

  const shown = complete ? conflicts : null;
  const blocking = shown?.filter((c) => c.severity === "blocking") ?? [];
  const warnings = shown?.filter((c) => c.severity === "overridable") ?? [];
  const allTicked = warnings.every((w) => acked.has(w.key));
  const canSave = canSaveSlot({
    complete,
    checking,
    pending,
    checkedKey,
    requestKey,
  });

  function update(changes: Partial<SlotDraft>) {
    setDraft((current) => {
      const next = { ...current, ...changes };
      if (changes.groupId && !current.teacherId) {
        const teacher = defaultTeacherForGroup(data.slots, changes.groupId);
        if (teacher) next.teacherId = teacher;
      }
      return next;
    });
    setSubmitError(null);
    setChanged(false);
  }

  function focusField(field: "group" | "room") {
    (field === "group" ? groupRef : roomRef).current?.focus();
  }

  function save() {
    if (!canSave) return;
    if (!complete) {
      setSubmitError(null);
      setError({ key: "scheduling.errors.INVALID_INPUT" });
      return;
    }
    if (blocking.length > 0) {
      setSubmitError("fixFirst");
      checkHeading.current?.focus();
      return;
    }
    if (!allTicked) {
      setSubmitError("tickAll");
      const first = warnings.find((w) => !acked.has(w.key));
      if (first) document.getElementById(`${id}-${first.key}`)?.focus();
      return;
    }
    setSubmitError(null);
    startTransition(async () => {
      try {
        const result = await saveSlotAction({
          ...request,
          acknowledgedConflictKeys: warnings.map((w) => w.key),
          ...(reason.trim() && { reason: reason.trim() }),
        });
        if (!result.ok) {
          setError(result.formError ?? { key: "common.error.unexpected" });
          return;
        }
        if (!result.data.saved) {
          const known = new Set((conflicts ?? []).map((c) => c.key));
          setNewKeys(
            new Set(
              result.data.conflicts
                .filter((c) => !known.has(c.key))
                .map((c) => c.key),
            ),
          );
          setConflicts(result.data.conflicts);
          setChanged(true);
          requestAnimationFrame(() => changedAlert.current?.focus());
          return;
        }
        onSaved(result.data, draft);
      } catch {
        setError({ key: "common.error.network" });
      }
    });
  }

  const summary = occurrenceSummary(
    {
      weekday: draft.weekday,
      validFrom: published
        ? effectiveFrom > (editing?.validFrom ?? term.startDate)
          ? effectiveFrom
          : (editing?.validFrom ?? term.startDate)
        : (editing?.validFrom ?? null),
      validUntil: editing?.validUntil ?? null,
    },
    term,
    data.holidays,
  );
  const weekdayLabel = (d: number) =>
    data.school.teachingWeekdays.includes(d)
      ? tc(`weekday.${d}` as "weekday.1")
      : t("slot.notSchoolDay", { weekday: tc(`weekday.${d}` as "weekday.1") });
  const duration = draft.endMinute - draft.startMinute;
  const visibleGroups = data.groups.filter(
    (g) => !g.archived || g.id === draft.groupId,
  );
  const visibleTeachers = data.teachers.filter(
    (x) => !x.archived || x.id === draft.teacherId,
  );
  const visibleRooms = data.rooms.filter(
    (r) => !r.archived || r.id === draft.roomId,
  );

  return (
    <>
      <SheetHeader className="pr-12">
        <div className="flex items-center justify-between gap-2">
          <SheetTitle>{title}</SheetTitle>
          {editing && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("slot.menu")}
                  />
                }
              >
                <MoreHorizontal aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() =>
                    onDuplicate({ ...draft, weekday: (draft.weekday % 7) + 1 })
                  }
                >
                  {t("slot.duplicate")}
                </DropdownMenuItem>
                {published && (
                  <DropdownMenuItem onClick={() => onEnd(editing)}>
                    {t("slot.endSlot")}
                  </DropdownMenuItem>
                )}
                {(!published || !editing.tookPlace) && (
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => onDelete(editing)}
                  >
                    {t("slot.delete")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </SheetHeader>

      <div className="flex flex-col gap-4 px-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-group`}>{t("slot.group")}</Label>
          <NativeSelect
            id={`${id}-group`}
            ref={groupRef}
            className="w-full"
            value={draft.groupId}
            onChange={(e) => update({ groupId: e.target.value })}
          >
            <NativeSelectOption value="" disabled>
              {t("slot.choose")}
            </NativeSelectOption>
            {visibleGroups.map((g) => (
              <NativeSelectOption key={g.id} value={g.id}>
                {t("slot.groupOption", {
                  name: g.archived
                    ? tc("archivedName", { name: g.name })
                    : g.name,
                  type:
                    g.type === "ONE_ON_ONE"
                      ? t("type.oneOnOne")
                      : t("type.group"),
                  level: g.level,
                  members: g.members,
                })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-teacher`}>{t("slot.teacher")}</Label>
          <NativeSelect
            id={`${id}-teacher`}
            className="w-full"
            value={draft.teacherId}
            onChange={(e) => update({ teacherId: e.target.value })}
          >
            <NativeSelectOption value="" disabled>
              {t("slot.choose")}
            </NativeSelectOption>
            {visibleTeachers.map((x) => (
              <NativeSelectOption key={x.id} value={x.id}>
                {x.archived ? tc("archivedName", { name: x.name }) : x.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-room`}>{t("slot.room")}</Label>
          <NativeSelect
            id={`${id}-room`}
            ref={roomRef}
            className="w-full"
            value={draft.roomId}
            onChange={(e) => update({ roomId: e.target.value })}
          >
            <NativeSelectOption value="">
              {t("editor.noRoom")}
            </NativeSelectOption>
            {visibleRooms.map((r) => {
              const name = r.archived
                ? tc("archivedName", { name: r.name })
                : r.name;
              return (
                <NativeSelectOption key={r.id} value={r.id}>
                  {r.online
                    ? t("slot.roomOnline", { name })
                    : r.capacity != null
                      ? t("slot.roomSeats", { name, count: r.capacity })
                      : name}
                </NativeSelectOption>
              );
            })}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-day`}>{t("slot.day")}</Label>
          <NativeSelect
            id={`${id}-day`}
            className="w-full"
            value={String(draft.weekday)}
            onChange={(e) => update({ weekday: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <NativeSelectOption key={d} value={d}>
                {weekdayLabel(d)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-start`}>{t("slot.start")}</Label>
            <NativeSelect
              id={`${id}-start`}
              className="w-full"
              value={String(draft.startMinute)}
              onChange={(e) => {
                const start = Number(e.target.value);
                update({
                  startMinute: start,
                  endMinute: Math.min(
                    24 * 60,
                    start + Math.max(duration, STEP),
                  ),
                });
              }}
            >
              {TIMES.slice(0, -1).map((m) => (
                <NativeSelectOption key={m} value={m}>
                  {formatMinutes(m)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-end`}>{t("slot.end")}</Label>
            <NativeSelect
              id={`${id}-end`}
              className="w-full"
              value={String(draft.endMinute)}
              aria-invalid={draft.endMinute <= draft.startMinute || undefined}
              aria-describedby={`${id}-duration`}
              onChange={(e) => update({ endMinute: Number(e.target.value) })}
            >
              {TIMES.slice(1).map((m) => (
                <NativeSelectOption key={m} value={m}>
                  {formatMinutes(m)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span id={`${id}-duration`} className="text-muted-foreground">
            {duration > 0
              ? t("slot.duration", { minutes: duration })
              : tc("none")}
          </span>
          {[45, 60, 90].map((m) => (
            <Button
              key={m}
              type="button"
              size="xs"
              variant={duration === m ? "secondary" : "outline"}
              onClick={() =>
                update({ endMinute: Math.min(24 * 60, draft.startMinute + m) })
              }
            >
              {t("slot.duration", { minutes: m })}
            </Button>
          ))}
        </div>
        {published && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-effective`}>{t("slot.effectiveFrom")}</Label>
            <Input
              id={`${id}-effective`}
              type="date"
              value={effectiveFrom}
              min={minEffective}
              max={term.endDate}
              required
              aria-describedby={`${id}-effective-hint`}
              onChange={(e) => {
                setEffectiveFrom(e.target.value || minEffective);
                setChanged(false);
              }}
            />
            <p
              id={`${id}-effective-hint`}
              className="text-xs text-muted-foreground"
            >
              {t("slot.effectiveFromHint")}
            </p>
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          {summary.count > 0 && summary.first && summary.last
            ? [
                t("slot.runs", {
                  weekday: tc(`weekday.${draft.weekday}` as "weekday.1"),
                  start: formatDate(summary.first, "dayMonth"),
                  end: formatDate(summary.last, "short"),
                  count: summary.count,
                }),
                t("slot.runsSkipped", { count: summary.skipped }),
              ]
                .filter(Boolean)
                .join(" · ")
            : t("slot.runsNone")}
        </p>
        {published && editing?.tookPlace && (
          <Alert>
            <AlertDescription>
              {t("slot.splitNote", {
                date: formatDate(effectiveFrom, "short"),
              })}
            </AlertDescription>
          </Alert>
        )}

        {/* Check (live) */}
        <section
          className="flex flex-col gap-2"
          aria-labelledby={`${id}-check`}
        >
          <h3
            id={`${id}-check`}
            ref={checkHeading}
            tabIndex={-1}
            className="text-sm font-semibold outline-none"
          >
            {submitError === "fixFirst"
              ? t("check.fixFirst")
              : t("check.title")}
          </h3>
          <div aria-live="polite" className="text-sm">
            {checking ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                {t("check.checking")}
              </span>
            ) : shown && shown.length === 0 ? (
              <span className="flex items-center gap-2 text-success">
                <CircleCheck aria-hidden="true" className="size-4" />
                {t("check.ok")}
              </span>
            ) : shown ? (
              <span className="font-medium">
                {t("check.summary", {
                  conflicts: blocking.length,
                  warnings: warnings.length,
                })}
              </span>
            ) : null}
          </div>
          {changed && (
            <Alert variant="destructive" ref={changedAlert} tabIndex={-1}>
              <AlertDescription>{t("check.changed")}</AlertDescription>
            </Alert>
          )}
          {blocking.length > 0 && (
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-medium">
                {t("check.conflicts")}{" "}
                <span className="font-normal text-muted-foreground">
                  · {render({ key: "scheduling.severity.blocking" })}
                </span>
              </h4>
              <ul className="flex flex-col gap-2">
                {blocking.map((c) => (
                  <ConflictRow
                    key={c.key}
                    conflict={c}
                    isNew={newKeys.has(c.key)}
                    onShowSlot={onShowSlot}
                    onFocusField={focusField}
                  />
                ))}
              </ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-medium">
                {t("check.warnings")}{" "}
                <span className="font-normal text-muted-foreground">
                  · {render({ key: "scheduling.severity.overridable" })}
                </span>
              </h4>
              <ul className="flex flex-col gap-2">
                {warnings.map((c) => (
                  <ConflictRow
                    key={c.key}
                    conflict={c}
                    isNew={newKeys.has(c.key)}
                    invalid={submitError === "tickAll" && !acked.has(c.key)}
                    onShowSlot={onShowSlot}
                    onFocusField={focusField}
                    // Checkboxes only once nothing blocks (§5.4).
                    acknowledge={
                      blocking.length === 0
                        ? {
                            id: `${id}-${c.key}`,
                            checked: acked.has(c.key),
                            onChange: (checked) => {
                              setAcked((current) => {
                                const next = new Set(current);
                                if (checked) next.add(c.key);
                                else next.delete(c.key);
                                return next;
                              });
                              setSubmitError(null);
                            },
                          }
                        : undefined
                    }
                  />
                ))}
              </ul>
              {submitError === "tickAll" && (
                <p role="alert" className="text-sm text-destructive">
                  {t("override.required")}
                </p>
              )}
              {blocking.length === 0 && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-reason`}>{t("override.reason")}</Label>
                  <Textarea
                    id={`${id}-reason`}
                    value={reason}
                    maxLength={500}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
              )}
            </div>
          )}
        </section>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{render(error)}</AlertDescription>
          </Alert>
        )}
      </div>

      <SheetFooter className="flex-row justify-end border-t bg-popover sm:sticky sm:bottom-0">
        <Button type="button" variant="outline" onClick={onClose}>
          {tc("cancel")}
        </Button>
        <Button type="button" onClick={save} disabled={!canSave}>
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {warnings.length > 0 && blocking.length === 0 && allTicked
            ? t("slot.saveAnyway")
            : t("slot.save")}
        </Button>
      </SheetFooter>
    </>
  );
}
