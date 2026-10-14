"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

import {
  ConfirmDialog,
  CredentialsDialog,
  FormDialog,
} from "@/components/admin/dialogs";
import { PasswordField } from "@/components/admin/fields";
import { setPasswordSchema } from "@/server/admin/people/schema";

import {
  archivePersonAction,
  type Credentials,
  restorePersonAction,
  setPasswordAction,
} from "./actions";

export type PersonRef = { userId: string; name: string };

/** "Set a new password for {name}" → credentials dialog (§5.4). */
export function SetPasswordDialog({
  person,
  open,
  onOpenChange,
}: {
  person: PersonRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("people");
  const tc = useTranslations("common");
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  return (
    <>
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t("password.dialogTitle", { name: person.name })}
        submitLabel={tc("save")}
        schema={setPasswordSchema}
        action={(previous, formData) =>
          setPasswordAction(person.userId, previous, formData)
        }
        onSuccess={(data) => setCredentials(data)}
      >
        <PasswordField autoFocus />
      </FormDialog>
      <CredentialsDialog
        credentials={credentials}
        onClose={() => setCredentials(null)}
      />
    </>
  );
}

/**
 * Archive confirm (consequences passed in) with an Undo toast, or the
 * blocked dialog when the server refuses (§5.3).
 */
export function ArchivePersonDialog({
  person,
  open,
  onOpenChange,
  consequences,
}: {
  person: PersonRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  consequences: ReactNode;
}) {
  const tc = useTranslations("common");
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tc("confirm.archiveTitle", { name: person.name })}
      description={consequences}
      confirmLabel={tc("archive")}
      destructive
      run={() => archivePersonAction(person.userId)}
      onDone={() =>
        toast(tc("toast.archived", { name: person.name }), {
          duration: 10_000,
          action: {
            label: tc("undo"),
            onClick: () => void restorePersonAction(person.userId),
          },
        })
      }
    />
  );
}

export function RestorePersonDialog({
  person,
  open,
  onOpenChange,
}: {
  person: PersonRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tc = useTranslations("common");
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tc("confirm.restoreTitle", { name: person.name })}
      confirmLabel={tc("restore")}
      run={() => restorePersonAction(person.userId)}
    />
  );
}
