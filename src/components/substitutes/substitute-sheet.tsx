"use client";

import {
  AlertTriangle,
  Check,
  CircleAlert,
  Info,
  Loader2,
  Star,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";

import {
  assignSubstituteAction,
  loadSubstituteSheetAction,
} from "@/app/admin/substitutions/actions";
import { ToneAlert } from "@/components/absences/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { SubstituteBand } from "@/server/scheduling/substitutes";
import type {
  NotifyPreview,
  SubstituteActionResult,
  SubstituteCandidate,
  SubstituteSheet as SheetData,
} from "@/server/substitutes/service";

import { useHours, useReasonText } from "./reason-text";
import { RemoveSubstituteDialog } from "./remove-dialog";

const BANDS: SubstituteBand[] = ["SUGGESTED", "WITH_WARNING", "NOT_POSSIBLE"];
const BAND_KEY = {
  SUGGESTED: "suggested",
  WITH_WARNING: "withWarning",
  NOT_POSSIBLE: "notPossible",
} as const;

/** "Mon 20 Oct 2026, 17:00–18:30" in the school's time zone. */
export function useLessonWhen() {
  const format = useFormatter();
  return useCallback(
    (startsAt: string, endsAt?: string) => {
      const start = new Date(startsAt);
      const date = format.dateTime(start, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      const time = (d: Date) =>
        format.dateTime(d, { hour: "2-digit", minute: "2-digit" });
      return endsAt
        ? `${date}, ${time(start)}–${time(new Date(endsAt))}`
        : `${date}, ${time(start)}`;
    },
    [format],
  );
}

/** "Mon 20 Oct" for toasts and titles. */
export function useLessonDay() {
  const format = useFormatter();
  return useCallback(
    (startsAt: string) =>
      format.dateTime(new Date(startsAt), {
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
    [format],
  );
}

/** "Ana Kral, Tomas Horvat and the 8 students of B1 Evening will be notified." */
export function useNotifyPreviewText() {
  const t = useTranslations("substitutes.picker");
  const format = useFormatter();
  return useCallback(
    (notify: NotifyPreview, group: string, ended: boolean) => {
      if (ended) return t("notifyNobody");
      const teachers = notify.teachers.map((teacher) => teacher.name);
      if (teachers.length === 0 && notify.studentCount === 0) {
        return t("notifyNobody");
      }
      // "Ana, Tomas and the 8 students…" / "Ana and Tomas will be notified."
      return notify.studentCount > 0
        ? t("notifyPreview", {
            names: format.list(teachers, { type: "unit", style: "short" }),
            count: notify.studentCount,
            group,
          })
        : t("notifyPreviewNoStudents", {
            names: format.list(teachers, { type: "conjunction" }),
          });
    },
    [t, format],
  );
}

type Problem =
  | { kind: "stale"; name: string }
  | { kind: "changed" }
  | { kind: "tooLate" }
  | { kind: "error" };

/**
 * _Find a substitute_ (docs/design/notifications-substitutes.md §5.3): the
 * server's ranked candidates in three sections, warnings that need an
 * "Assign anyway" tick, and the notification preview. The server re-checks
 * everything on Assign.
 */
export function SubstituteSheet({
  lessonId,
  onClose,
  onAssigned,
}: {
  /** The lesson to cover; null = closed. */
  lessonId: string | null;
  onClose: () => void;
  /** After a successful assign or remove. */
  onAssigned?: (lessonId: string) => void;
}) {
  const t = useTranslations("substitutes");
  const tc = useTranslations("common");
  const isMobile = useIsMobile();
  return (
    <Sheet open={lessonId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        closeLabel={tc("close")}
        className={cn(
          "gap-0 p-0",
          isMobile ? "h-[95svh]" : "w-full data-[side=right]:sm:max-w-[520px]",
        )}
      >
        <SheetHeader className="border-b">
          <SheetTitle>{t("picker.title")}</SheetTitle>
          <SheetDescription className="sr-only">
            {t("picker.description")}
          </SheetDescription>
        </SheetHeader>
        {lessonId && (
          <SheetBody
            key={lessonId}
            lessonId={lessonId}
            onClose={onClose}
            onAssigned={onAssigned}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function SheetBody({
  lessonId,
  onClose,
  onAssigned,
}: {
  lessonId: string;
  onClose: () => void;
  onAssigned?: (lessonId: string) => void;
}) {
  const t = useTranslations("substitutes");
  const router = useRouter();
  const when = useLessonWhen();
  const day = useLessonDay();
  const notifyText = useNotifyPreviewText();
  const [data, setData] = useState<SheetData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState(false);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    const result = await loadSubstituteSheetAction(lessonId);
    if (result.ok) {
      setData(result.data);
      setLoadError(false);
    } else {
      setLoadError(true);
    }
  }, [lessonId]);

  useEffect(() => {
    // Loading the candidates is what opening the sheet syncs with.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const candidate = useMemo(
    () => data?.candidates.find((c) => c.teacherId === selected) ?? null,
    [data, selected],
  );

  if (loadError) {
    return (
      <div className="p-4">
        <ToneAlert tone="danger" icon={CircleAlert}>
          <span className="flex flex-col items-start gap-2">
            {t("error.load")}
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t("error.retry")}
            </Button>
          </span>
        </ToneAlert>
      </div>
    );
  }
  if (!data) {
    return (
      <div
        className="flex flex-col gap-3 p-4"
        role="status"
        aria-label={t("picker.loading")}
      >
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  const { lesson } = data;
  const actionsHidden = data.lessonReasons.length > 0;
  const current = data.candidates.find((c) => c.current) ?? null;
  const q = query.trim().toLowerCase();
  const visible = data.candidates.filter(
    (c) => !c.current && (!q || c.name.toLowerCase().includes(q)),
  );
  const suggestedCount = data.candidates.filter(
    (c) => !c.current && c.band === "SUGGESTED",
  ).length;
  const possible = data.candidates.filter(
    (c) => !c.current && c.band !== "NOT_POSSIBLE",
  );
  const warnings = candidate?.band === "WITH_WARNING" ? candidate.reasons : [];

  const submit = () => {
    if (!candidate) return;
    startTransition(async () => {
      setProblem(null);
      const result = await assignSubstituteAction({
        lessonId: lesson.id,
        teacherId: candidate.teacherId,
        expectedSubstituteId: data.expected.substituteId,
        expectedStartsAt: data.expected.startsAt,
        acknowledgedKeys: acknowledged ? warnings.map((w) => w.key) : [],
        reason: null,
      });
      if (!result.ok) {
        setProblem({ kind: "error" });
        return;
      }
      handleResult(result.data, candidate.name);
    });
  };

  const handleResult = (result: SubstituteActionResult, name: string) => {
    switch (result.status) {
      case "done":
        toast.success(
          t("assigned", {
            name: result.name,
            group: result.group,
            date: day(result.startsAt),
          }),
        );
        onAssigned?.(lesson.id);
        router.refresh();
        onClose();
        return;
      case "changed":
        setProblem({ kind: "changed" });
        return;
      case "lessonRefused":
        setProblem({ kind: "tooLate" });
        return;
      case "refused":
      case "unacknowledged":
      case "regularBusy":
        setProblem({ kind: "stale", name });
        setSelected(null);
        setAcknowledged(false);
        void load();
        return;
    }
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex flex-col gap-1 border-b px-4 py-3">
          <p className="font-semibold" data-testid="sheet-lesson">
            {t("picker.lessonLine", {
              group: lesson.groupName,
              type: t(`type.${lesson.groupType}`),
              level: lesson.level ?? "none",
            })}
          </p>
          <p className="text-muted-foreground tabular-nums">
            {t("picker.whenLine", {
              when: when(lesson.startsAt, lesson.endsAt),
              room: lesson.room ?? "none",
            })}
          </p>
          <p>
            {data.needsCover && data.needsCover.who === "REGULAR"
              ? t("picker.regularWhy", {
                  teacher: lesson.regular.name,
                  why: t(`why.${data.needsCover.reasons[0]}`, {
                    otherGroup: data.needsCover.otherGroup ?? "",
                  }),
                })
              : t("picker.regular", { teacher: lesson.regular.name })}
          </p>
          {lesson.substitute && (
            <p>{t("picker.current", { name: lesson.substitute.name })}</p>
          )}
        </div>

        <div className="flex flex-col gap-3 px-4 py-3">
          {lesson.phase === "started" && !actionsHidden && (
            <ToneAlert tone="warning" icon={AlertTriangle}>
              {t("picker.started")}
            </ToneAlert>
          )}
          {lesson.phase === "ended" && !actionsHidden && (
            <ToneAlert tone="info" icon={Info}>
              {t("picker.ended")}
            </ToneAlert>
          )}
          {data.lessonReasons.map((code) => (
            <ToneAlert key={code} tone="warning" icon={AlertTriangle}>
              {t(`lessonReasons.${code}`)}
            </ToneAlert>
          ))}
          {problem?.kind === "stale" && (
            <ToneAlert tone="warning" icon={AlertTriangle}>
              {t("stale", { name: problem.name })}
            </ToneAlert>
          )}
          {problem?.kind === "changed" && (
            <ToneAlert tone="warning" icon={AlertTriangle}>
              <span className="flex flex-col items-start gap-2">
                {t("lessonChanged")}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setProblem(null);
                    setSelected(null);
                    setData(null);
                    void load();
                  }}
                >
                  {t("reload")}
                </Button>
              </span>
            </ToneAlert>
          )}
          {problem?.kind === "tooLate" && (
            <ToneAlert tone="warning" icon={AlertTriangle}>
              {t("lessonReasons.TOO_LATE_TO_RECORD")}
            </ToneAlert>
          )}
          {problem?.kind === "error" && (
            <ToneAlert tone="danger" icon={CircleAlert}>
              {t("error.assign")}
            </ToneAlert>
          )}

          {!actionsHidden && (
            <>
              {current && (
                <CandidateRow
                  candidate={current}
                  group={lesson.groupName}
                  level={lesson.level}
                  disabled
                  badge={t("picker.currentBadge")}
                />
              )}
              {suggestedCount === 0 && possible.length > 0 && (
                <ToneAlert tone="warning" icon={AlertTriangle}>
                  {t("picker.noneSuggested")} {t("picker.noneSuggestedHint")}
                </ToneAlert>
              )}
              {possible.length === 0 && (
                <ToneAlert tone="warning" icon={AlertTriangle}>
                  <span className="flex flex-col items-start gap-1">
                    {t("picker.nobody")}
                    <Link
                      href={`/admin/lessons/${lesson.id}`}
                      className="underline underline-offset-4"
                    >
                      {t("picker.moveLesson")}
                    </Link>
                  </span>
                </ToneAlert>
              )}
              <input
                type="search"
                aria-label={t("picker.search")}
                placeholder={t("picker.search")}
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {q && visible.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("picker.noMatch", { query })}
                </p>
              )}
              <RadioGroup
                value={selected}
                onValueChange={(value) => {
                  setSelected(value as string);
                  setAcknowledged(false);
                  setProblem(null);
                }}
                disabled={pending}
                className="gap-4"
              >
                {BANDS.map((band) => {
                  const items = visible.filter((c) => c.band === band);
                  if (items.length === 0) return null;
                  const headingId = `band-${band}`;
                  const section = (
                    <div
                      role="group"
                      aria-labelledby={headingId}
                      className="flex flex-col gap-1"
                    >
                      <h3
                        id={headingId}
                        className="text-xs font-semibold text-muted-foreground uppercase"
                      >
                        {t(`picker.${BAND_KEY[band]}`, {
                          count: data.candidates.filter(
                            (c) => !c.current && c.band === band,
                          ).length,
                        })}
                      </h3>
                      {items.map((c) => (
                        <CandidateRow
                          key={c.teacherId}
                          candidate={c}
                          group={lesson.groupName}
                          level={lesson.level}
                          disabled={band === "NOT_POSSIBLE"}
                        />
                      ))}
                    </div>
                  );
                  return band === "NOT_POSSIBLE" &&
                    suggestedCount + possible.length > 0 ? (
                    <details key={band}>
                      <summary className="cursor-pointer text-xs font-semibold text-muted-foreground uppercase">
                        {t("picker.notPossible", { count: items.length })}
                      </summary>
                      <div className="mt-1">{section}</div>
                    </details>
                  ) : (
                    <div key={band}>{section}</div>
                  );
                })}
              </RadioGroup>
            </>
          )}
        </div>
      </div>

      {!actionsHidden && (
        <SheetFooter className="border-t">
          {warnings.length > 0 && candidate && (
            <ToneAlert tone="warning" icon={AlertTriangle}>
              <span className="flex flex-col gap-1">
                {t("picker.warningsFor", { name: candidate.name })}
                <ReasonList reasons={candidate} />
                <label className="mt-1 flex items-center gap-2 font-medium text-foreground">
                  <Checkbox
                    checked={acknowledged}
                    onCheckedChange={(v) => setAcknowledged(v === true)}
                  />
                  {t("picker.assignAnyway")}
                </label>
              </span>
            </ToneAlert>
          )}
          {candidate && (
            <p
              className="flex items-start gap-2 text-sm text-muted-foreground"
              data-testid="notify-preview"
            >
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {notifyText(
                candidate.notify,
                lesson.groupName,
                lesson.phase === "ended",
              )}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("picker.cancel")}
            </Button>
            {current && data.remove && (
              <Button variant="outline" onClick={() => setRemoving(true)}>
                {t("removeAction")}
              </Button>
            )}
            <Button
              disabled={
                !candidate || pending || (warnings.length > 0 && !acknowledged)
              }
              onClick={submit}
            >
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {pending
                ? t("picker.assigning")
                : candidate
                  ? t("picker.assign", { name: candidate.name })
                  : t("picker.assignNone")}
            </Button>
          </div>
        </SheetFooter>
      )}
      {data.remove && lesson.substitute && (
        <RemoveSubstituteDialog
          open={removing}
          onOpenChange={setRemoving}
          lesson={{
            id: lesson.id,
            groupName: lesson.groupName,
            startsAt: lesson.startsAt,
            regular: lesson.regular.name,
            substitute: lesson.substitute.name,
            phase: lesson.phase,
          }}
          remove={data.remove}
          expected={data.expected}
          onRemoved={() => {
            onAssigned?.(lesson.id);
            onClose();
          }}
          onFindAnother={() => setRemoving(false)}
        />
      )}
    </>
  );
}

function ReasonList({ reasons: candidate }: { reasons: SubstituteCandidate }) {
  const reasonText = useReasonText();
  return (
    <ul className="list-disc pl-5">
      {candidate.reasons.map((r) => (
        <li key={r.key}>{reasonText(r)}</li>
      ))}
    </ul>
  );
}

/** One teacher in the picker: name, rule checks or warnings, hints. */
function CandidateRow({
  candidate: c,
  group,
  level,
  disabled,
  badge,
}: {
  candidate: SubstituteCandidate;
  group: string;
  level: string | null;
  disabled?: boolean;
  badge?: string;
}) {
  const t = useTranslations("substitutes");
  const reasonText = useReasonText();
  const hours = useHours();
  const id = `candidate-${c.teacherId}`;
  const detailsId = `${id}-details`;
  const checks =
    c.band === "SUGGESTED"
      ? [
          ...(level ? [t("reason.teachesLevel", { level })] : []),
          t("reason.free"),
          t("reason.hours", {
            current: hours(c.facts.weekMinutesBefore),
            with: hours(c.facts.weekMinutesAfter),
            max:
              c.facts.maxMinutes === null ? "none" : hours(c.facts.maxMinutes),
          }),
        ]
      : [];
  return (
    <label
      htmlFor={disabled ? undefined : id}
      className={cn(
        "flex items-start gap-3 rounded-lg px-2 py-2",
        disabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-muted",
      )}
    >
      {badge ? (
        <span className="size-4 shrink-0" aria-hidden="true" />
      ) : (
        <RadioGroupItem
          id={id}
          value={c.teacherId}
          disabled={disabled}
          aria-disabled={disabled || undefined}
          aria-describedby={detailsId}
          className="mt-0.5"
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "flex flex-wrap items-center gap-2 font-medium",
            disabled && !badge && "text-muted-foreground",
          )}
        >
          {c.rank !== null && (
            <span
              className="tabular-nums"
              aria-label={t("picker.rank", { rank: c.rank })}
            >
              {c.rank}
            </span>
          )}
          {c.name}
          {badge && <Badge variant="secondary">{badge}</Badge>}
        </span>
        <span
          id={detailsId}
          className="flex flex-col gap-0.5 text-xs text-muted-foreground"
        >
          {checks.length > 0 && (
            <span className="flex flex-wrap gap-x-3">
              {checks.map((text) => (
                <span key={text} className="flex items-center gap-1">
                  <Check aria-hidden="true" className="size-3 text-success" />
                  {text}
                </span>
              ))}
            </span>
          )}
          {c.reasons.map((r) => (
            <span key={r.key} className="flex items-center gap-1">
              {r.severity === "overridable" ? (
                <AlertTriangle
                  aria-hidden="true"
                  className="size-3 text-warning"
                />
              ) : (
                <X aria-hidden="true" className="size-3 text-danger" />
              )}
              {reasonText(r)}
            </span>
          ))}
          {c.hints.map((hint) => (
            <span key={hint} className="flex items-center gap-1">
              <Star aria-hidden="true" className="size-3 text-warning" />
              {t(`hint.${hint}`, { group })}
            </span>
          ))}
        </span>
      </span>
    </label>
  );
}
