"use client";

import {
  AlertTriangle,
  Check,
  CircleAlert,
  EllipsisVertical,
  Loader2,
  Shuffle,
  User,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { useReasonText } from "@/components/absences/reason-text";
import { ToneAlert, ToneBadge } from "@/components/absences/tone";
import { useMessage } from "@/components/admin/use-message";
import { CharCounter } from "@/components/lessons/char-counter";
import { formatMinutes, useDateFormat } from "@/components/timetable/format";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { Message } from "@/server/admin/result";
import type {
  AdminBookingRow,
  OverrideOption,
  ReasonView,
} from "@/server/replacements/booking";
import { REVIEW_NOTE_MAX } from "@/server/replacements/schema";

import {
  approveReplacementsAction,
  loadOverrideOptionsAction,
  overrideReplacementAction,
  rejectReplacementAction,
} from "./actions";

type LessonRef = AdminBookingRow["from"];

/** "Mon 13 Oct, 17:00 · B1 Evening" as a link to the admin lesson page. */
export function LessonCell({ lesson }: { lesson: LessonRef }) {
  const t = useTranslations("adminAbsences");
  const formatDate = useDateFormat();
  return (
    <Link href={`/admin/lessons/${lesson.id}`} className="hover:underline">
      {t("lessonRef", {
        date: formatDate(lesson.date, "weekdayLong"),
        time: formatMinutes(lesson.startMinute),
        group: lesson.groupName,
      })}
    </Link>
  );
}

/** Live issues of a booking as warning badges (§7.3). */
export function IssuesCell({ row }: { row: AdminBookingRow }) {
  const t = useTranslations("adminAbsences");
  const reasonText = useReasonText();
  return (
    <span className="flex flex-wrap gap-1">
      {row.issues.map((issue) => (
        <ToneBadge key={issue.key} tone="warning" icon={AlertTriangle}>
          {reasonText(issue)}
        </ToneBadge>
      ))}
      {row.room && row.room.capacity === null && (
        <span className="text-xs text-muted-foreground">
          {t("noRoomLimit")}
        </span>
      )}
    </span>
  );
}

/** Admin status badge of a booking (§3.2). */
export function StatusBadge({ row }: { row: AdminBookingRow }) {
  const t = useTranslations("adminAbsences.status");
  switch (row.status) {
    case "AUTO_APPROVED":
      return <ToneBadge tone="info">{t("needsReview")}</ToneBadge>;
    case "APPROVED":
      return <ToneBadge tone="success">{t("approved")}</ToneBadge>;
    case "REJECTED":
      return <ToneBadge tone="danger">{t("rejected")}</ToneBadge>;
    case "OVERRIDDEN":
      return <ToneBadge tone="warning">{t("overridden")}</ToneBadge>;
    default:
      return (
        <ToneBadge tone="muted">
          {row.cancelReason === "LESSON_CANCELLED"
            ? t("lessonCancelled")
            : t("cancelledByStudent")}
        </ToneBadge>
      );
  }
}

const isActive = (row: AdminBookingRow) =>
  ["AUTO_APPROVED", "APPROVED", "OVERRIDDEN"].includes(row.status);

/**
 * The Review tab (§7.3): unreviewed bookings with their live issues, bulk
 * approve for rows without issues, Override… for rows with them.
 */
export function ReviewTable({ rows }: { rows: AdminBookingRow[] }) {
  const t = useTranslations("adminAbsences");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const router = useRouter();
  const render = useMessage();
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const selectable = rows.filter((r) => r.issues.length === 0);
  const allSelected =
    selectable.length > 0 && selected.length === selectable.length;

  function approve(ids: string[]) {
    startTransition(async () => {
      const result = await approveReplacementsAction(ids).catch(() => null);
      if (!result) {
        toast.error(render({ key: "common.error.network" }));
        return;
      }
      if (!result.ok) {
        toast.error(
          render(result.formError ?? { key: "common.error.unexpected" }),
        );
        return;
      }
      if (result.data.status === "changed") {
        toast.warning(t("changedMeanwhile"));
      } else {
        toast.success(t("approve.done", { count: ids.length }));
      }
      setSelected([]);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {selected.length > 0 && (
        <div className="flex items-center gap-3 rounded-md border bg-muted px-3 py-2 text-sm">
          <span aria-live="polite">
            {t("selected", { count: selected.length })}
          </span>
          <Button
            size="sm"
            disabled={pending}
            onClick={() => approve(selected)}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            <Check aria-hidden="true" />
            {t("approve.selected", { count: selected.length })}
          </Button>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border">
        <Table>
          <TableCaption className="sr-only">
            {t("tab.review", { count: rows.length })}
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label={t("col.selectAll")}
                  checked={allSelected}
                  disabled={selectable.length === 0}
                  onCheckedChange={(checked) =>
                    setSelected(checked ? selectable.map((r) => r.id) : [])
                  }
                />
              </TableHead>
              <TableHead>{t("col.booked")}</TableHead>
              <TableHead>{t("col.student")}</TableHead>
              <TableHead>{t("col.from")}</TableHead>
              <TableHead>{t("col.to")}</TableHead>
              <TableHead>{t("col.seats")}</TableHead>
              <TableHead>{t("col.issues")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("col.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Checkbox
                    aria-label={t("col.select")}
                    checked={selected.includes(row.id)}
                    disabled={row.issues.length > 0}
                    onCheckedChange={(checked) =>
                      setSelected((current) =>
                        checked
                          ? [...current, row.id]
                          : current.filter((id) => id !== row.id),
                      )
                    }
                  />
                </TableCell>
                <TableCell className="tabular-nums">
                  <time dateTime={row.bookedAt}>
                    {format.relativeTime(new Date(row.bookedAt), now)}
                  </time>
                </TableCell>
                <TableCell>
                  <Link
                    href={`/admin/students/${row.student.id}`}
                    className="hover:underline"
                  >
                    {row.student.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <LessonCell lesson={row.from} />
                </TableCell>
                <TableCell>
                  <LessonCell lesson={row.to} />
                </TableCell>
                <TableCell className="tabular-nums">
                  {row.room?.capacity != null
                    ? t("seats", {
                        taken: row.seatsTaken,
                        capacity: row.room.capacity,
                      })
                    : "—"}
                </TableCell>
                <TableCell>
                  <IssuesCell row={row} />
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {row.issues.length === 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => approve([row.id])}
                    >
                      {t("approve.action")}
                    </Button>
                  )}
                  <BookingRowActions row={row} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Row menu: Reject…, Override…, Open student (§7.2). */
export function BookingRowActions({ row }: { row: AdminBookingRow }) {
  const t = useTranslations("adminAbsences");
  const [dialog, setDialog] = useState<"reject" | "override" | null>(null);
  const reviewable = isActive(row) && !row.to.started;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("col.actions")}
            />
          }
        >
          <EllipsisVertical aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {reviewable && (
            <>
              <DropdownMenuItem onClick={() => setDialog("override")}>
                <Shuffle aria-hidden="true" />
                {t("override.action")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDialog("reject")}
              >
                <X aria-hidden="true" />
                {t("reject.action")}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem
            render={<Link href={`/admin/students/${row.student.id}`} />}
          >
            <User aria-hidden="true" />
            {t("openStudent")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "reject" && (
        <RejectDialog row={row} onClose={() => setDialog(null)} />
      )}
      {dialog === "override" && (
        <OverrideDialog row={row} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function ReasonField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error: boolean;
}) {
  const t = useTranslations("adminAbsences");
  const id = useId();
  const hintId = useId();
  const counterId = useId();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{t("reason")}</Label>
      <Textarea
        id={id}
        rows={2}
        value={value}
        maxLength={REVIEW_NOTE_MAX + 50}
        aria-invalid={error || value.trim().length > REVIEW_NOTE_MAX}
        aria-describedby={`${hintId} ${counterId}`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        {t("reasonHint")}
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {t("reasonRequired")}
        </p>
      )}
      <CharCounter
        id={counterId}
        count={value.trim().length}
        max={REVIEW_NOTE_MAX}
      />
    </div>
  );
}

/** Reject… (§7.3): the booking goes, the credit comes back with grace. */
function RejectDialog({
  row,
  onClose,
}: {
  row: AdminBookingRow;
  onClose: () => void;
}) {
  const t = useTranslations("adminAbsences");
  const tc = useTranslations("common");
  const formatDate = useDateFormat();
  const render = useMessage();
  const router = useRouter();
  const [note, setNote] = useState("");
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [changed, setChanged] = useState(false);
  const [pending, startTransition] = useTransition();
  const now = useNow();
  // At least 7 days from today (decision 10); the server has the final date.
  const graceDate = new Date(now.getTime() + 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  function run() {
    if (!note.trim()) {
      setMissing(true);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await rejectReplacementAction({
        bookingId: row.id,
        note,
        expectedStatus: row.status,
      }).catch(() => null);
      if (!result) return setError({ key: "common.error.network" });
      if (!result.ok) {
        return setError(
          result.formError ??
            Object.values(result.fieldErrors ?? {})[0] ?? {
              key: "common.error.unexpected",
            },
        );
      }
      if (result.data.status === "changed") return setChanged(true);
      toast.success(t("reject.done"));
      onClose();
      router.refresh();
    });
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("reject.title", {
              student: row.student.name,
              date: formatDate(row.to.date, "weekdayLong"),
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("reject.body", {
              expiry: formatDate(graceDate, "weekdayDate"),
            })}{" "}
            {t("reject.bodyGrace")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ReasonField
          value={note}
          onChange={(value) => {
            setNote(value);
            setMissing(false);
          }}
          error={missing}
        />
        {changed && (
          <ToneAlert tone="warning" icon={AlertTriangle}>
            {t("changedMeanwhile")}
          </ToneAlert>
        )}
        {error && (
          <ToneAlert tone="danger" icon={CircleAlert}>
            {render(error)}
          </ToneAlert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {tc("cancel")}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={
              pending || changed || note.trim().length > REVIEW_NOTE_MAX
            }
            onClick={run}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {t("reject.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Override… (§7.3): keep the booking or move it to another lesson despite
 * overridable reasons, each acknowledged with its own checkbox.
 */
function OverrideDialog({
  row,
  onClose,
}: {
  row: AdminBookingRow;
  onClose: () => void;
}) {
  const t = useTranslations("adminAbsences");
  const tc = useTranslations("common");
  const formatDate = useDateFormat();
  const format = useFormatter();
  const render = useMessage();
  const reasonText = useReasonText();
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
  const [data, setData] = useState<{
    current: OverrideOption;
    options: OverrideOption[];
  } | null>(null);
  const [choice, setChoice] = useState<string>("keep");
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [missing, setMissing] = useState(false);
  const [blocked, setBlocked] = useState<ReasonView[] | null>(null);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    loadOverrideOptionsAction(row.id, showAll)
      .then((result) => {
        if (!active) return;
        if (result.ok) setData(result.data);
        else setError(result.formError ?? { key: "common.error.unexpected" });
      })
      .catch(() => active && setError({ key: "common.error.network" }));
    return () => {
      active = false;
    };
  }, [row.id, showAll]);

  const chosen =
    choice === "keep"
      ? data?.current
      : data?.options.find((o) => o.id === choice);
  const reasons = blocked ?? chosen?.reasons ?? [];
  const label = (o: OverrideOption) =>
    t("lessonRef", {
      date: formatDate(o.date, "weekdayLong"),
      time: formatMinutes(o.startMinute),
      group: o.groupName,
    });
  const allAcknowledged = reasons
    .filter((r) => r.overridable)
    .every((r) => acknowledged.includes(r.key));
  const isBlocked = reasons.some((r) => !r.overridable);

  function run() {
    if (!note.trim()) {
      setMissing(true);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await overrideReplacementAction({
        bookingId: row.id,
        targetLessonId: choice === "keep" ? null : choice,
        acknowledgedKeys: acknowledged,
        note,
        expectedStatus: row.status,
      }).catch(() => null);
      if (!result) return setError({ key: "common.error.network" });
      if (!result.ok) {
        return setError(
          result.formError ??
            Object.values(result.fieldErrors ?? {})[0] ?? {
              key: "common.error.unexpected",
            },
        );
      }
      if (result.data.status === "changed") return setChanged(true);
      if (result.data.status === "reasons") {
        // The reasons changed meanwhile: show the fresh ones to tick.
        setBlocked(result.data.reasons);
        return;
      }
      toast.success(
        choice === "keep" || !result.data.startsAt
          ? t("override.kept")
          : t("override.moved", {
              dateTime: format.dateTime(new Date(result.data.startsAt), {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              }),
            }),
      );
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("override.title", { student: row.student.name })}
          </DialogTitle>
          <DialogDescription>
            {data && t("override.current", { lesson: label(data.current) })}
          </DialogDescription>
        </DialogHeader>
        {!data && !error && (
          <p className="text-sm text-muted-foreground">
            {t("override.loading")}
          </p>
        )}
        {data && (
          <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">{t("override.options")}</legend>
              <OptionRow
                value="keep"
                checked={choice === "keep"}
                onPick={() => {
                  setChoice("keep");
                  setAcknowledged([]);
                  setBlocked(null);
                }}
                label={t("override.keep", { lesson: label(data.current) })}
                reasons={data.current.reasons}
              />
              <div className="flex items-center justify-between gap-2 pt-2">
                <span className="text-sm font-medium">
                  {t("override.options")}
                </span>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={showAll} onCheckedChange={setShowAll} />
                  {t("override.showAll")}
                </label>
              </div>
              {data.options.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("override.none")}
                </p>
              )}
              {data.options.map((o) => (
                <OptionRow
                  key={o.id}
                  value={o.id}
                  checked={choice === o.id}
                  onPick={() => {
                    setChoice(o.id);
                    setAcknowledged([]);
                    setBlocked(null);
                  }}
                  label={t("override.optionLabel", {
                    lesson: label(o),
                    room: o.roomName ?? t("noRoom"),
                    teacher: o.teacherName,
                  })}
                  reasons={o.reasons}
                />
              ))}
            </fieldset>
          </div>
        )}
        {isBlocked && (
          <ToneAlert tone="danger" icon={CircleAlert}>
            {t("override.blocked")}{" "}
            {reasons
              .filter((r) => !r.overridable)
              .map(reasonText)
              .join(", ")}
          </ToneAlert>
        )}
        {reasons.filter((r) => r.overridable).length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {reasons
              .filter((r) => r.overridable)
              .map((r) => (
                <li key={r.key} className="flex items-start gap-2">
                  <Checkbox
                    id={`ack-${row.id}-${r.key}`}
                    checked={acknowledged.includes(r.key)}
                    onCheckedChange={(checked) =>
                      setAcknowledged((current) =>
                        checked
                          ? [...current, r.key]
                          : current.filter((k) => k !== r.key),
                      )
                    }
                  />
                  <Label
                    htmlFor={`ack-${row.id}-${r.key}`}
                    className="font-normal"
                  >
                    {t("override.ack", { reason: reasonText(r) })}
                  </Label>
                </li>
              ))}
          </ul>
        )}
        <ReasonField
          value={note}
          onChange={(value) => {
            setNote(value);
            setMissing(false);
          }}
          error={missing}
        />
        {changed && (
          <ToneAlert tone="warning" icon={AlertTriangle}>
            {t("changedMeanwhile")}
          </ToneAlert>
        )}
        {error && (
          <ToneAlert tone="danger" icon={CircleAlert}>
            {render(error)}
          </ToneAlert>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button
            disabled={
              pending ||
              !data ||
              changed ||
              isBlocked ||
              !allAcknowledged ||
              note.trim().length > REVIEW_NOTE_MAX
            }
            onClick={run}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {t("override.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OptionRow({
  value,
  checked,
  onPick,
  label,
  reasons,
}: {
  value: string;
  checked: boolean;
  onPick: () => void;
  label: string;
  reasons: ReasonView[];
}) {
  const t = useTranslations("adminAbsences.override");
  const reasonText = useReasonText();
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm has-checked:border-primary">
      <input
        type="radio"
        name="override-target"
        value={value}
        checked={checked}
        onChange={onPick}
        className="mt-1"
      />
      <span className="flex flex-col gap-1">
        <span>{label}</span>
        <span className="flex flex-wrap gap-1">
          {reasons.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              {t("noIssues")}
            </span>
          ) : (
            reasons.map((r) => (
              <ToneBadge key={r.key} tone="warning" icon={AlertTriangle}>
                {reasonText(r)}
              </ToneBadge>
            ))
          )}
        </span>
      </span>
    </label>
  );
}
