"use client";

import { Check, MoreHorizontal, Plus } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  ArchivePersonDialog,
  RestorePersonDialog,
  SetPasswordDialog,
} from "@/app/admin/_people/person-dialogs";
import type { Credentials } from "@/app/admin/_people/actions";
import { CredentialsDialog, FormDialog } from "@/components/admin/dialogs";
import { PasswordField, TextField } from "@/components/admin/fields";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  createTeacherSchema,
  TEACHER_COLORS,
  type TeacherColor,
} from "@/server/admin/people/schema";

import { createTeacherAction } from "./actions";

/**
 * Timetable colour as a radio group of 8 named swatches (§6.2, §8): each
 * swatch has a visible name and focus ring; the selected one shows a check.
 */
export function ColorSwatchField({
  defaultValue,
}: {
  defaultValue: TeacherColor | null;
}) {
  const t = useTranslations("teachers");
  const [value, setValue] = useState<TeacherColor | null>(defaultValue);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{t("field.color")}</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(Object.keys(TEACHER_COLORS) as TeacherColor[]).map((name) => (
          <label
            key={name}
            className="flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm has-checked:border-primary has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
          >
            <input
              type="radio"
              name="color"
              value={name}
              checked={value === name}
              onChange={() => setValue(name)}
              className="sr-only"
            />
            <span
              aria-hidden="true"
              className="flex size-5 shrink-0 items-center justify-center rounded-full text-white"
              style={{ backgroundColor: TEACHER_COLORS[name] }}
            >
              {value === name && <Check className="size-3.5" />}
            </span>
            {t(`color.${name}`)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Small colour dot in front of a teacher's name (decorative). */
export function ColorDot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2.5 shrink-0 rounded-full bg-muted-foreground"
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

export function NewTeacherButton({
  label,
  nextColor,
}: {
  label?: string;
  nextColor: TeacherColor;
}) {
  const t = useTranslations("teachers");
  const tp = useTranslations("people");
  const [open, setOpen] = useState(false);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        {label ?? t("new")}
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t("newTitle")}
        submitLabel={t("create")}
        schema={createTeacherSchema}
        action={createTeacherAction}
        onSuccess={(data) => setCredentials(data)}
      >
        <TextField name="name" label={tp("field.name")} autoFocus />
        <TextField name="email" type="email" label={tp("field.email")} />
        <PasswordField />
        <ColorSwatchField defaultValue={nextColor} />
      </FormDialog>
      <CredentialsDialog
        credentials={credentials}
        onClose={() => setCredentials(null)}
      />
    </>
  );
}

export type TeacherRow = {
  id: string;
  userId: string;
  name: string;
  archived: boolean;
};

export function TeacherRowActions({ teacher }: { teacher: TeacherRow }) {
  const t = useTranslations("teachers");
  const tc = useTranslations("common");
  const tp = useTranslations("people");
  const [dialog, setDialog] = useState<
    "password" | "archive" | "restore" | null
  >(null);
  const close = (open: boolean) => !open && setDialog(null);
  const person = { userId: teacher.userId, name: teacher.name };
  const href = `/admin/teachers/${teacher.id}`;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tc("actionsFor", { name: teacher.name })}
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem render={<Link href={href} />}>
            {t("action.edit")}
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href={`${href}?tab=availability`} />}>
            {t("action.availability")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialog("password")}>
            {tp("password.setNew")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {teacher.archived ? (
            <DropdownMenuItem onClick={() => setDialog("restore")}>
              {tc("restore")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => setDialog("archive")}>
              {tc("archive")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <TeacherDialogs person={person} dialog={dialog} onOpenChange={close} />
    </>
  );
}

/** Set password / archive / restore dialogs for one teacher. */
export function TeacherDialogs({
  person,
  dialog,
  onOpenChange,
}: {
  person: { userId: string; name: string };
  dialog: "password" | "archive" | "restore" | null;
  onOpenChange: (open: boolean) => void;
}) {
  const tp = useTranslations("people");
  const firstName = person.name.split(/\s+/)[0];
  return (
    <>
      <SetPasswordDialog
        person={person}
        open={dialog === "password"}
        onOpenChange={onOpenChange}
      />
      <ArchivePersonDialog
        person={person}
        open={dialog === "archive"}
        onOpenChange={onOpenChange}
        consequences={
          <ul className="list-disc pl-5">
            <li>{tp("archive.consequenceSignIn", { firstName })}</li>
            <li>{tp("archive.consequenceHistory")}</li>
          </ul>
        }
      />
      <RestorePersonDialog
        person={person}
        open={dialog === "restore"}
        onOpenChange={onOpenChange}
      />
    </>
  );
}
