"use client";

import { CircleAlert, Eye, Loader2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { useMessage } from "@/components/admin/use-message";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { FieldErrors, Message } from "@/server/admin/result";
import { COVERED_MAX, HOMEWORK_MAX } from "@/server/lessons/rules";
import type { LessonLogView } from "@/server/lessons/teacher";

import { CharCounter } from "./char-counter";
import { LinkifiedText } from "./linkified-text";

type SaveAction = (input: {
  lessonId: string;
  content: string;
  homework: string;
  expectedUpdatedAt: string | null;
}) => Promise<
  | {
      ok: true;
      data:
        | { status: "saved"; log: LessonLogView | null }
        | { status: "conflict"; by: string | null };
      message?: Message;
    }
  | { ok: false; fieldErrors?: FieldErrors; formError?: Message }
>;

/** "Last saved by {name}, {dateTime}" in the school's time zone. */
function LastSaved({ log }: { log: LessonLogView }) {
  const t = useTranslations("lessonLog");
  const format = useFormatter();
  return (
    <p className="text-sm text-muted-foreground">
      {t("lastSaved", {
        name: log.updatedByName,
        dateTime: format.dateTime(new Date(log.updatedAt), {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }),
      })}
    </p>
  );
}

function CardHeading() {
  const t = useTranslations("lessonLog");
  return (
    <CardHeader>
      <CardTitle>
        <h2 className="text-lg font-semibold">{t("title")}</h2>
      </CardTitle>
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Eye aria-hidden="true" className="size-4" />
        {t("visibleToStudents")}
      </p>
    </CardHeader>
  );
}

/**
 * The lesson log as text, for cancelled lessons and for admins (lessons.md
 * §5.2, §7): "What we covered", the homework and who saved it last.
 */
export function ReadOnlyLogCard({
  log,
  empty,
}: {
  log: LessonLogView | null;
  /** Shown instead when there is no log. */
  empty?: string;
}) {
  const t = useTranslations("lessonLog");
  return (
    <Card>
      <CardHeading />
      <CardContent className="flex flex-col gap-4">
        {!log && empty && <p className="text-muted-foreground">{empty}</p>}
        {log?.content && (
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">{t("covered")}</h3>
            <LinkifiedText text={log.content} />
          </div>
        )}
        {log?.homework && (
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">{t("homework")}</h3>
            <LinkifiedText text={log.homework} />
          </div>
        )}
        {log && <LastSaved log={log} />}
      </CardContent>
    </Card>
  );
}

/**
 * Lesson log card (lessons.md §5.2): "What we covered" and "Homework" in
 * one form with one Save button. Read-only on cancelled lessons, a hint
 * before the lesson starts.
 */
export function LessonLogCard({
  lessonId,
  lock,
  log,
  save,
  onDirtyChange,
}: {
  lessonId: string;
  lock: "cancelled" | "notStarted" | null;
  log: LessonLogView | null;
  save: SaveAction;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useTranslations("lessonLog");
  const tc = useTranslations("common");
  const render = useMessage();
  const router = useRouter();
  const ids = useId();
  const [saved, setSaved] = useState(log);
  const [content, setContent] = useState(log?.content ?? "");
  const [homework, setHomework] = useState(log?.homework ?? "");
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<
    | { kind: "error"; message?: Message }
    | { kind: "conflict"; by: string | null }
    | null
  >(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  if (lock === "cancelled") {
    // A log written before the lesson was cancelled stays, read-only.
    if (!log) return null;
    return <ReadOnlyLogCard log={log} />;
  }

  if (lock === "notStarted") {
    return (
      <Card>
        <CardHeading />
        <CardContent>
          <p className="text-muted-foreground">{t("notYet")}</p>
        </CardContent>
      </Card>
    );
  }

  const dirty =
    content !== (saved?.content ?? "") || homework !== (saved?.homework ?? "");
  const removing = saved !== null && !content.trim() && !homework.trim();

  function edit(field: "content" | "homework", value: string) {
    const next = { content, homework, [field]: value };
    if (field === "content") setContent(value);
    else setHomework(value);
    onDirtyChange(
      next.content !== (saved?.content ?? "") ||
        next.homework !== (saved?.homework ?? ""),
    );
    if (errors[field]) {
      setErrors((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== field),
        ),
      );
    }
  }

  function submit() {
    const local: FieldErrors = {};
    if (content.trim().length > COVERED_MAX) {
      local.content = {
        key: "lessonLog.tooLong",
        values: { max: COVERED_MAX },
      };
    }
    if (homework.trim().length > HOMEWORK_MAX) {
      local.homework = {
        key: "lessonLog.tooLong",
        values: { max: HOMEWORK_MAX },
      };
    }
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    setFailure(null);
    startTransition(async () => {
      try {
        const result = await save({
          lessonId,
          content,
          homework,
          expectedUpdatedAt: saved?.updatedAt ?? null,
        });
        if (!result.ok) {
          setErrors(result.fieldErrors ?? {});
          if (!result.fieldErrors) {
            setFailure({ kind: "error", message: result.formError });
          }
          return;
        }
        if (result.data.status === "conflict") {
          // The typed text stays in the fields.
          setFailure({ kind: "conflict", by: result.data.by });
          return;
        }
        const next = result.data.log;
        setSaved(next);
        setContent(next?.content ?? "");
        setHomework(next?.homework ?? "");
        onDirtyChange(false);
        if (result.message) toast.success(render(result.message));
        router.refresh();
      } catch {
        setFailure({ kind: "error" });
      }
    });
  }

  const coveredId = `${ids}-covered`;
  const homeworkId = `${ids}-homework`;
  return (
    <Card>
      <CardHeading />
      <CardContent>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (removing) setConfirmRemove(true);
            else submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={coveredId}>{t("covered")}</Label>
            <Textarea
              id={coveredId}
              name="content"
              rows={4}
              className="min-h-24"
              placeholder={t("coveredPlaceholder")}
              value={content}
              disabled={pending}
              aria-invalid={errors.content ? true : undefined}
              aria-describedby={`${coveredId}-count ${coveredId}-error`}
              onChange={(event) => edit("content", event.target.value)}
            />
            <CharCounter
              id={`${coveredId}-count`}
              count={content.trim().length}
              max={COVERED_MAX}
            />
            <p id={`${coveredId}-error`} className="text-sm text-destructive">
              {errors.content ? render(errors.content) : null}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={homeworkId}>{t("homework")}</Label>
            <p
              id={`${homeworkId}-hint`}
              className="text-sm text-muted-foreground"
            >
              {t("homeworkHint")}
            </p>
            <Textarea
              id={homeworkId}
              name="homework"
              rows={2}
              className="min-h-14"
              placeholder={t("homeworkPlaceholder")}
              value={homework}
              disabled={pending}
              aria-invalid={errors.homework ? true : undefined}
              aria-describedby={`${homeworkId}-hint ${homeworkId}-count ${homeworkId}-error`}
              onChange={(event) => edit("homework", event.target.value)}
            />
            <CharCounter
              id={`${homeworkId}-count`}
              count={homework.trim().length}
              max={HOMEWORK_MAX}
            />
            <p id={`${homeworkId}-error`} className="text-sm text-destructive">
              {errors.homework ? render(errors.homework) : null}
            </p>
          </div>
          {failure?.kind === "conflict" && (
            <Alert className="border-warning-border bg-warning-surface text-warning">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription className="text-warning">
                {failure.by
                  ? t("conflict", { name: failure.by })
                  : t("conflictRemoved")}
              </AlertDescription>
            </Alert>
          )}
          {failure?.kind === "error" && (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {failure.message ? render(failure.message) : t("saveError")}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={submit}
                >
                  {tc("retry")}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>{saved && <LastSaved log={saved} />}</div>
            <Button
              type="submit"
              variant={dirty ? "default" : "outline"}
              disabled={pending}
            >
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {t("save")}
            </Button>
          </div>
        </form>
      </CardContent>
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("remove.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("remove.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmRemove(false);
                submit();
              }}
            >
              {t("remove.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
