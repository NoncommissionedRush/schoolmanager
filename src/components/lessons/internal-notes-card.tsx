"use client";

import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Lock,
  MoreHorizontal,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { type ReactNode, useId, useState, useTransition } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult, Message } from "@/server/admin/result";
import { NOTE_MAX } from "@/server/lessons/rules";
import type { NoteView } from "@/server/notes/teacher-notes";

import { CharCounter } from "./char-counter";
import { LinkifiedText } from "./linkified-text";

/** Loads the next page of earlier notes ("Show more"). */
export type LoadEarlierNotes = (
  lessonId: string,
  offset: number,
) => Promise<ActionResult<NoteView[]>>;

/** Server actions for teachers; omitted on read-only (admin) pages. */
export type NoteActions = {
  create: (input: {
    lessonId: string;
    about: string;
    body: string;
  }) => Promise<ActionResult<NoteView>>;
  update: (input: {
    noteId: string;
    body: string;
  }) => Promise<ActionResult<NoteView>>;
  remove: (noteId: string) => Promise<ActionResult<{ id: string }>>;
};

function failureMessage(result: ActionResult<unknown>): Message | null {
  if (result.ok) return null;
  return (
    result.formError ??
    Object.values(result.fieldErrors ?? {})[0] ?? {
      key: "common.error.unexpected",
    }
  );
}

/**
 * The internal style (lessons.md §4): dashed slate border, a dark band that
 * always says who can see this, and a labelled region.
 */
export function InternalSection({
  headingId,
  heading,
  children,
}: {
  headingId: string;
  heading: string;
  children: ReactNode;
}) {
  const t = useTranslations("teacherNotes");
  return (
    <section
      aria-labelledby={headingId}
      data-internal="true"
      className="overflow-hidden rounded-xl border border-dashed border-internal bg-internal-surface text-slate-900"
    >
      <p className="flex items-center gap-2 bg-internal-band px-4 py-2 text-sm font-medium text-white">
        <Lock aria-hidden="true" className="size-4 shrink-0" />
        {t("internalBanner")}
      </p>
      <div className="flex flex-col gap-4 p-4">
        <h2 id={headingId} className="text-lg font-semibold">
          {heading}
        </h2>
        {children}
      </div>
    </section>
  );
}

function AboutChip({ note }: { note: NoteView }) {
  const t = useTranslations("teacherNotes");
  const label =
    note.about.kind === "student"
      ? t("about.student", { name: note.about.name })
      : note.about.kind === "group"
        ? t("about.group", { group: note.about.name })
        : t("chip.lesson");
  return (
    <Badge variant="outline" className="bg-white">
      {label}
    </Badge>
  );
}

function NoteItem({
  note,
  actions,
  onChanged,
  onDeleted,
  showLessonDate,
}: {
  note: NoteView;
  actions: NoteActions | null;
  onChanged: (note: NoteView) => void;
  onDeleted: (id: string) => void;
  showLessonDate?: boolean;
}) {
  const t = useTranslations("teacherNotes");
  const tc = useTranslations("common");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const render = useMessage();
  const fieldId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [error, setError] = useState<Message | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, startTransition] = useTransition();
  const created = new Date(note.createdAt);

  function saveEdit() {
    if (!actions) return;
    startTransition(async () => {
      const result = await actions.update({ noteId: note.id, body: draft });
      if (result.ok) {
        setEditing(false);
        setError(null);
        onChanged(result.data);
      } else {
        setError(failureMessage(result));
      }
    });
  }

  function remove() {
    if (!actions) return;
    startTransition(async () => {
      const result = await actions.remove(note.id);
      setConfirmDelete(false);
      if (result.ok) {
        onDeleted(note.id);
        if (result.message) toast.success(render(result.message));
      } else {
        const message = failureMessage(result);
        if (message) toast.error(render(message));
      }
    });
  }

  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-slate-300 bg-white p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">{note.author.name}</span>
        <time
          dateTime={note.createdAt}
          title={format.dateTime(created, {
            dateStyle: "full",
            timeStyle: "short",
          })}
          className="text-slate-600"
        >
          {format.relativeTime(created, now)}
        </time>
        {note.edited && <span className="text-slate-600">· {t("edited")}</span>}
        <AboutChip note={note} />
        {note.own && actions && !editing && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
                  aria-label={t("actions")}
                />
              }
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  setDraft(note.body);
                  setEditing(true);
                }}
              >
                {t("edit")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setConfirmDelete(true)}
              >
                {t("delete.action")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {showLessonDate && note.lessonStartsAt && (
        <p className="text-xs text-slate-600">
          {t("fromLesson", {
            date: format.dateTime(new Date(note.lessonStartsAt), {
              weekday: "short",
              day: "numeric",
              month: "short",
            }),
          })}
        </p>
      )}
      {editing ? (
        <form
          noValidate
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            saveEdit();
          }}
        >
          <Label htmlFor={fieldId}>{t("field")}</Label>
          <Textarea
            id={fieldId}
            value={draft}
            rows={3}
            className="bg-white"
            disabled={pending}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${fieldId}-count`}
            onChange={(event) => setDraft(event.target.value)}
          />
          <CharCounter
            id={`${fieldId}-count`}
            count={draft.trim().length}
            max={NOTE_MAX}
          />
          {error && <p className="text-sm text-destructive">{render(error)}</p>}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              {tc("cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {t("save")}
            </Button>
          </div>
        </form>
      ) : (
        <LinkifiedText text={note.body} className="text-sm" />
      )}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("delete.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={remove}
            >
              {t("delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function AddNoteForm({
  lessonId,
  groupName,
  students,
  create,
  onAdded,
}: {
  lessonId: string;
  groupName: string;
  students: { id: string; name: string }[];
  create: NoteActions["create"];
  onAdded: (note: NoteView) => void;
}) {
  const t = useTranslations("teacherNotes");
  const render = useMessage();
  const ids = useId();
  const [about, setAbout] = useState("lesson");
  const [body, setBody] = useState("");
  const [error, setError] = useState<Message | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!body.trim()) {
      setError({ key: "validation.requiredField" });
      return;
    }
    if (body.trim().length > NOTE_MAX) {
      setError({ key: "teacherNotes.tooLong", values: { max: NOTE_MAX } });
      return;
    }
    startTransition(async () => {
      const result = await create({ lessonId, about, body });
      if (result.ok) {
        setBody("");
        setError(null);
        onAdded(result.data);
        // Never a toast with note content (§4.4): only the fixed message.
        if (result.message) toast.success(render(result.message));
      } else {
        setError(failureMessage(result));
      }
    });
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${ids}-about`}>{t("about.label")}</Label>
        <NativeSelect
          id={`${ids}-about`}
          className="w-full bg-white"
          value={about}
          disabled={pending}
          onChange={(event) => setAbout(event.target.value)}
        >
          <NativeSelectOption value="lesson">
            {t("about.lesson")}
          </NativeSelectOption>
          <NativeSelectOption value="group">
            {t("about.group", { group: groupName })}
          </NativeSelectOption>
          {students.map((s) => (
            <NativeSelectOption key={s.id} value={`student:${s.id}`}>
              {t("about.student", { name: s.name })}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${ids}-body`}>{t("field")}</Label>
        <Textarea
          id={`${ids}-body`}
          rows={3}
          className="bg-white"
          value={body}
          disabled={pending}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${ids}-count ${ids}-error`}
          onChange={(event) => {
            setBody(event.target.value);
            if (error) setError(null);
          }}
        />
        <CharCounter
          id={`${ids}-count`}
          count={body.trim().length}
          max={NOTE_MAX}
        />
        <p id={`${ids}-error`} className="text-sm text-destructive">
          {error ? render(error) : null}
        </p>
      </div>
      <Button type="submit" className="self-start" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {t("add")}
      </Button>
    </form>
  );
}

/**
 * Internal notes card of a lesson page (lessons.md §5.3): add form (teachers
 * only), notes on this lesson, and earlier notes about the group and its
 * current students, collapsed.
 */
export function InternalNotesCard({
  lessonId,
  groupName,
  students,
  initial,
  actions,
  loadEarlier,
}: {
  lessonId: string;
  groupName: string;
  students: { id: string; name: string }[];
  initial: { onLesson: NoteView[]; earlier: NoteView[]; earlierCount: number };
  actions: NoteActions | null;
  loadEarlier: LoadEarlierNotes;
}) {
  const t = useTranslations("teacherNotes");
  const render = useMessage();
  const ids = useId();
  const [onLesson, setOnLesson] = useState(initial.onLesson);
  const [earlier, setEarlier] = useState(initial.earlier);
  const [earlierCount, setEarlierCount] = useState(initial.earlierCount);
  const [expanded, setExpanded] = useState(false);
  const [loadError, setLoadError] = useState<Message | null>(null);
  const [loading, startLoading] = useTransition();

  const replace = (list: NoteView[], note: NoteView) =>
    list.map((n) => (n.id === note.id ? note : n));

  function showMore() {
    startLoading(async () => {
      const result = await loadEarlier(lessonId, earlier.length);
      if (result.ok) {
        setEarlier((current) => [
          ...current,
          ...result.data.filter((n) => !current.some((c) => c.id === n.id)),
        ]);
        setLoadError(null);
      } else {
        setLoadError(failureMessage(result));
      }
    });
  }

  const empty = onLesson.length === 0 && earlierCount === 0;
  return (
    <InternalSection headingId={`${ids}-heading`} heading={t("title")}>
      {actions && (
        <AddNoteForm
          lessonId={lessonId}
          groupName={groupName}
          students={students}
          create={actions.create}
          onAdded={(note) => setOnLesson((current) => [note, ...current])}
        />
      )}
      {empty ? (
        <p className="text-sm text-slate-700">{t("empty")}</p>
      ) : (
        <>
          {onLesson.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t("onThisLesson")}</h3>
              <ul className="flex flex-col gap-2">
                {onLesson.map((note) => (
                  <NoteItem
                    key={note.id}
                    note={note}
                    actions={actions}
                    onChanged={(n) => setOnLesson((list) => replace(list, n))}
                    onDeleted={(id) =>
                      setOnLesson((list) => list.filter((n) => n.id !== id))
                    }
                  />
                ))}
              </ul>
            </div>
          )}
          {earlierCount > 0 && (
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="ghost"
                className="h-auto justify-start px-0 py-1 text-left whitespace-normal hover:bg-transparent"
                aria-expanded={expanded}
                aria-controls={`${ids}-earlier`}
                onClick={() => setExpanded((open) => !open)}
              >
                {expanded ? (
                  <ChevronDown aria-hidden="true" />
                ) : (
                  <ChevronRight aria-hidden="true" />
                )}
                {t("earlier", { count: earlierCount })}
              </Button>
              <div id={`${ids}-earlier`} hidden={!expanded}>
                <ul className="flex flex-col gap-2">
                  {earlier.map((note) => (
                    <NoteItem
                      key={note.id}
                      note={note}
                      actions={actions}
                      showLessonDate
                      onChanged={(n) => setEarlier((list) => replace(list, n))}
                      onDeleted={(id) => {
                        setEarlier((list) => list.filter((n) => n.id !== id));
                        setEarlierCount((count) => count - 1);
                      }}
                    />
                  ))}
                </ul>
                {loadError && (
                  <Alert variant="destructive" className="mt-2">
                    <AlertDescription>{render(loadError)}</AlertDescription>
                  </Alert>
                )}
                {earlier.length < earlierCount && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    disabled={loading}
                    onClick={showMore}
                  >
                    {loading && (
                      <Loader2 aria-hidden="true" className="animate-spin" />
                    )}
                    {t("showMore")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </InternalSection>
  );
}

/**
 * A read-only list of internal notes in the internal style, e.g. all notes
 * about one student on the admin's student detail (lessons.md §7).
 */
export function ReadOnlyNotesCard({
  heading,
  notes,
  empty,
}: {
  heading: string;
  notes: NoteView[];
  empty: string;
}) {
  const ids = useId();
  return (
    <InternalSection headingId={`${ids}-heading`} heading={heading}>
      {notes.length === 0 ? (
        <p className="text-sm text-slate-700">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map((note) => (
            <NoteItem
              key={note.id}
              note={note}
              actions={null}
              showLessonDate
              onChanged={() => {}}
              onDeleted={() => {}}
            />
          ))}
        </ul>
      )}
    </InternalSection>
  );
}
