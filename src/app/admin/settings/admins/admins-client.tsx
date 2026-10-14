"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import type { Credentials } from "@/app/admin/_people/actions";
import {
  ArchivePersonDialog,
  RestorePersonDialog,
  SetPasswordDialog,
} from "@/app/admin/_people/person-dialogs";
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
import { createAdminSchema } from "@/server/admin/people/schema";

import { createAdminAction } from "./actions";

export function NewAdminButton() {
  const t = useTranslations("admins");
  const tp = useTranslations("people");
  const [open, setOpen] = useState(false);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        {t("new")}
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t("newTitle")}
        submitLabel={t("create")}
        schema={createAdminSchema}
        action={createAdminAction}
        onSuccess={(data) => setCredentials(data)}
      >
        <TextField name="name" label={tp("field.name")} autoFocus />
        <TextField name="email" type="email" label={tp("field.email")} />
        <PasswordField />
      </FormDialog>
      <CredentialsDialog
        credentials={credentials}
        onClose={() => setCredentials(null)}
      />
    </>
  );
}

/** Row menu: Set new password · Archive / Restore (none for your own row). */
export function AdminRowActions({
  admin,
}: {
  admin: { userId: string; name: string; archived: boolean; self: boolean };
}) {
  const t = useTranslations("admins");
  const tc = useTranslations("common");
  const tp = useTranslations("people");
  const [dialog, setDialog] = useState<
    "password" | "archive" | "restore" | null
  >(null);
  const close = (open: boolean) => !open && setDialog(null);
  const person = { userId: admin.userId, name: admin.name };
  const firstName = admin.name.split(/\s+/)[0];
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tc("actionsFor", { name: admin.name })}
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setDialog("password")}>
            {tp("password.setNew")}
          </DropdownMenuItem>
          {!admin.self && (
            <>
              <DropdownMenuSeparator />
              {admin.archived ? (
                <DropdownMenuItem onClick={() => setDialog("restore")}>
                  {tc("restore")}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setDialog("archive")}>
                  {tc("archive")}
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <SetPasswordDialog
        person={person}
        open={dialog === "password"}
        onOpenChange={close}
      />
      <ArchivePersonDialog
        person={person}
        open={dialog === "archive"}
        onOpenChange={close}
        consequences={
          <ul className="list-disc pl-5">
            <li>{tp("archive.consequenceSignIn", { firstName })}</li>
            <li>{t("archive.consequenceAccess")}</li>
          </ul>
        }
      />
      <RestorePersonDialog
        person={person}
        open={dialog === "restore"}
        onOpenChange={close}
      />
    </>
  );
}
