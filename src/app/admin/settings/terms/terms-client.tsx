"use client";

import { Info, MoreHorizontal, Plus, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog, FormDialog } from "@/components/admin/dialogs";
import {
  RadioGroupField,
  SelectField,
  TextField,
} from "@/components/admin/fields";
import { useMessage } from "@/components/admin/use-message";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  holidaySchema,
  touchedPublishedTerms,
} from "@/server/admin/holidays/schema";
import type { Message } from "@/server/admin/result";
import { overlappingTerms, termSchema } from "@/server/admin/terms/schema";

import {
  deleteHolidayAction,
  deleteTermAction,
  saveHolidayAction,
  saveTermAction,
} from "./actions";

type TermOption = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  published: boolean;
};

type Term = TermOption & {
  slots: number;
  holidays: number;
  lessons: number;
};

type Holiday = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  termId: string | null;
};

/** Shared result toast after lessons changed (timetable.md §5.10). */
function useLessonToast() {
  const t = useTranslations("terms.result");
  const format = useFormatter();
  const render = useMessage();
  return (action: string, parts: Message[]) =>
    toast.success(
      t("toast", {
        action,
        changes: format.list(parts.map(render), { type: "unit" }),
      }),
    );
}

export function NewTermButton({
  terms,
  label,
}: {
  terms: TermOption[];
  label?: string;
}) {
  const t = useTranslations("terms");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        {label ?? t("new")}
      </Button>
      <TermDialog open={open} onOpenChange={setOpen} terms={terms} today="" />
    </>
  );
}

function TermDialog({
  term,
  terms,
  today,
  open,
  onOpenChange,
}: {
  term?: Term;
  terms: TermOption[];
  today: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("terms");
  const lessonToast = useLessonToast();
  const initial = () => ({
    startDate: term?.startDate ?? "",
    endDate: term?.endDate ?? "",
  });
  const [dates, setDates] = useState(initial);
  // Every opening starts from the stored values (the trigger owns `open`).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDates(initial());
  }
  const schema = termSchema(
    term
      ? {
          published: term.published,
          original: { startDate: term.startDate, endDate: term.endDate },
          today,
        }
      : undefined,
  );
  // Overlap is a warning, not an error (§6.8).
  const overlaps =
    dates.startDate && dates.endDate && dates.startDate <= dates.endDate
      ? overlappingTerms(dates, terms, term?.id)
      : [];

  function track(event: FormEvent<HTMLDivElement>) {
    const target = event.target as HTMLInputElement;
    if (target.name === "startDate" || target.name === "endDate") {
      setDates((current) => ({ ...current, [target.name]: target.value }));
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={term ? t("editTitle") : t("newTitle")}
      description={term?.published ? t("impact.datesChanged") : undefined}
      submitLabel={term ? t("editSubmit") : t("create")}
      schema={schema}
      action={(previous, formData) =>
        saveTermAction(term?.id ?? null, previous, formData)
      }
      onSuccess={(data) => {
        if (data.lessons) lessonToast(t("toast.saved"), data.lessons);
      }}
    >
      <div className="contents" onChange={track}>
        <TextField
          name="name"
          label={t("field.name")}
          placeholder={t("field.namePlaceholder")}
          defaultValue={term?.name}
          autoFocus
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="startDate"
            type="date"
            label={t("field.start")}
            defaultValue={term?.startDate}
          />
          <TextField
            name="endDate"
            type="date"
            label={t("field.end")}
            defaultValue={term?.endDate}
          />
        </div>
        {overlaps.map((other) => (
          <Alert key={other.id}>
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>
              {t("warning.overlap", { term: other.name })}
            </AlertDescription>
          </Alert>
        ))}
      </div>
    </FormDialog>
  );
}

export function TermRowActions({
  term,
  terms,
  today,
}: {
  term: Term;
  terms: TermOption[];
  today: string;
}) {
  const t = useTranslations("terms");
  const tc = useTranslations("common");
  const router = useRouter();
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const close = (open: boolean) => !open && setDialog(null);
  // Only before publishing and without lessons (§5.3); the server re-checks.
  const deletable = !term.published && term.lessons === 0;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tc("actionsFor", { name: term.name })}
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setDialog("edit")}>
            {tc("edit")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => router.push(`/admin/timetable/edit?term=${term.id}`)}
          >
            {t("openTimetable")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={!deletable}
            onClick={() => setDialog("delete")}
          >
            <span className="flex flex-col">
              {tc("delete")}
              {!deletable && (
                <span className="text-xs text-muted-foreground">
                  {t("delete.publishedHint")}
                </span>
              )}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <TermDialog
        term={term}
        terms={terms}
        today={today}
        open={dialog === "edit"}
        onOpenChange={close}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={close}
        title={tc("confirm.deleteTitle", { name: term.name })}
        description={
          <>
            <p>
              {t("delete.cascade", {
                slots: term.slots,
                holidays: term.holidays,
              })}
            </p>
            <p>{tc("confirm.irreversible")}</p>
          </>
        }
        confirmLabel={tc("delete")}
        destructive
        run={() => deleteTermAction(term.id)}
      />
    </>
  );
}

export function NewHolidayButton({ terms }: { terms: TermOption[] }) {
  const t = useTranslations("holidays");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        {t("new")}
      </Button>
      <HolidayDialog open={open} onOpenChange={setOpen} terms={terms} />
    </>
  );
}

function HolidayDialog({
  holiday,
  terms,
  open,
  onOpenChange,
}: {
  holiday?: Holiday;
  terms: TermOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("holidays");
  const lessonToast = useLessonToast();
  const initial = () => ({
    scope: holiday?.termId ? "term" : "school",
    termId: holiday?.termId ?? "",
    startDate: holiday?.startDate ?? "",
    endDate: holiday?.endDate ?? "",
  });
  const [values, setValues] = useState(initial);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setValues(initial());
  }
  const termId = values.scope === "term" ? values.termId || null : null;
  const dates = values.startDate && values.endDate;
  // Before or after the change, a published term's lessons follow (§6.8).
  const touchesPublished =
    (!!dates &&
      (values.scope === "school" || termId !== null) &&
      touchedPublishedTerms(
        { termId, startDate: values.startDate, endDate: values.endDate },
        terms,
      ).length > 0) ||
    (!!holiday && touchedPublishedTerms(holiday, terms).length > 0);

  function track(event: FormEvent<HTMLDivElement>) {
    const target = event.target as HTMLInputElement;
    if (target.name === "startDate" || target.name === "endDate") {
      setValues((current) => ({ ...current, [target.name]: target.value }));
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={holiday ? t("editTitle") : t("newTitle")}
      submitLabel={holiday ? t("editSubmit") : t("create")}
      schema={holidaySchema}
      action={(previous, formData) =>
        saveHolidayAction(
          holiday?.id ?? null,
          touchesPublished,
          previous,
          formData,
        )
      }
      onSuccess={(data) => {
        if (data.lessons) lessonToast(t("toast.saved"), data.lessons);
      }}
    >
      <div className="contents" onChange={track}>
        <TextField
          name="name"
          label={t("field.name")}
          placeholder={t("field.namePlaceholder")}
          defaultValue={holiday?.name}
          autoFocus
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="startDate"
            type="date"
            label={t("field.start")}
            defaultValue={holiday?.startDate}
          />
          <TextField
            name="endDate"
            type="date"
            label={t("field.end")}
            defaultValue={holiday?.endDate}
          />
        </div>
        <RadioGroupField
          name="scope"
          legend={t("field.scope")}
          value={values.scope}
          onChange={(scope) => setValues((current) => ({ ...current, scope }))}
          options={[
            { value: "school", label: t("scope.school") },
            { value: "term", label: t("scope.onlyTerm") },
          ]}
        />
        {/* Kept mounted so the chosen term survives switching scope. */}
        <div hidden={values.scope !== "term"}>
          <SelectField
            name="termId"
            label={t("field.term")}
            placeholder={t("field.termPlaceholder")}
            value={values.termId}
            onChange={(id) =>
              setValues((current) => ({ ...current, termId: id }))
            }
            options={terms.map((term) => ({
              value: term.id,
              label: t("scope.term", { term: term.name }),
            }))}
          />
        </div>
        {touchesPublished && (
          <Alert>
            <Info aria-hidden="true" />
            <AlertDescription>{t("confirm.add")}</AlertDescription>
          </Alert>
        )}
      </div>
    </FormDialog>
  );
}

export function HolidayRowActions({
  holiday,
  terms,
  touchesPublished,
}: {
  holiday: Holiday;
  terms: TermOption[];
  touchesPublished: boolean;
}) {
  const t = useTranslations("holidays");
  const tc = useTranslations("common");
  const lessonToast = useLessonToast();
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const close = (open: boolean) => !open && setDialog(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tc("actionsFor", { name: holiday.name })}
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setDialog("edit")}>
            {tc("edit")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setDialog("delete")}
          >
            {tc("delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <HolidayDialog
        holiday={holiday}
        terms={terms}
        open={dialog === "edit"}
        onOpenChange={close}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={close}
        title={tc("confirm.deleteTitle", { name: holiday.name })}
        description={
          touchesPublished ? t("confirm.delete") : tc("confirm.irreversible")
        }
        confirmLabel={tc("delete")}
        destructive
        run={() => deleteHolidayAction(holiday.id, touchesPublished)}
        onDone={(result) => {
          if (result.data.lessons)
            lessonToast(t("toast.deleted"), result.data.lessons);
        }}
      />
    </>
  );
}
