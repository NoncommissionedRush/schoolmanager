"use client";

import { Copy, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";
import type { z } from "zod";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ActionResult, Blocked, Message } from "@/server/admin/result";

import { AdminForm, type FormAction, SubmitButton } from "./form";
import { useMessage } from "./use-message";

/**
 * Create/edit dialog (§5.2). Controlled: the caller owns `open`, so row
 * menus and buttons can open it. Closes and toasts on success.
 */
export function FormDialog<T>({
  open,
  onOpenChange,
  title,
  description,
  action,
  schema,
  submitLabel,
  onSuccess,
  successToast,
  children,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  action: FormAction<T>;
  schema?: z.ZodType;
  submitLabel: ReactNode;
  onSuccess?: (data: NoInfer<T>) => void;
  /** Toast after success; the server's message wins when it sends one. */
  successToast?: string | ((data: NoInfer<T>) => string);
  children: ReactNode;
  wide?: boolean;
}) {
  const t = useTranslations("common");
  const render = useMessage();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={wide ? "sm:max-w-2xl" : "sm:max-w-lg"}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {/* Remount on open so every opening starts from fresh values. */}
        {open && (
          <AdminForm
            action={action}
            schema={schema}
            onSuccess={(result) => {
              onOpenChange(false);
              const text = result.message
                ? render(result.message)
                : typeof successToast === "function"
                  ? successToast(result.data)
                  : successToast;
              if (text) toast.success(text);
              onSuccess?.(result.data);
            }}
            footer={(pending) => (
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  {t("cancel")}
                </Button>
                <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
              </DialogFooter>
            )}
          >
            {children}
          </AdminForm>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Confirm + run a server action (archive, restore, delete …). A "blocked"
 * result switches the dialog to the blocked state (§5.3).
 */
export function ConfirmDialog<T>({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  run,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: ReactNode;
  destructive?: boolean;
  run: () => Promise<ActionResult<T>>;
  onDone?: (result: Extract<ActionResult<T>, { ok: true }>) => void;
}) {
  const t = useTranslations("common");
  const render = useMessage();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<Message | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);

  function close(next: boolean) {
    if (!next) {
      setError(null);
      setBlocked(null);
    }
    onOpenChange(next);
  }

  if (blocked) {
    return (
      <BlockedDialog
        open={open}
        onOpenChange={close}
        blocked={blocked}
        render={render}
      />
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription render={<div />}>
              {description}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {render(error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t("cancel")}
          </AlertDialogCancel>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await run();
                if (result.ok) {
                  close(false);
                  if (result.message) toast.success(render(result.message));
                  onDone?.(result);
                } else if (result.blocked) {
                  setBlocked(result.blocked);
                } else {
                  setError(
                    result.formError ??
                      Object.values(result.fieldErrors ?? {})[0] ?? {
                        key: "common.error.unexpected",
                      },
                  );
                }
              })
            }
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "{name} can't be archived yet" — reason, up to 5 items, optional link. */
export function BlockedDialog({
  open,
  onOpenChange,
  blocked,
  render,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blocked: Blocked;
  render: (message: Message) => string;
}) {
  const t = useTranslations("common");
  const items = blocked.items ?? [];
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{render(blocked.title)}</AlertDialogTitle>
          <AlertDialogDescription>
            {render(blocked.reason)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {items.length > 0 && (
          <ul className="list-disc pl-5 text-sm">
            {items.slice(0, 5).map((item) => (
              <li key={item}>{item}</li>
            ))}
            {items.length > 5 && (
              <li>{t("blocked.more", { count: items.length - 5 })}</li>
            )}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("ok")}</AlertDialogCancel>
          {blocked.link && (
            <a href={blocked.link.href} className={buttonVariants()}>
              {render(blocked.link.label)}
            </a>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Shown once after a password is set (§5.4): email + password, Copy, Done. */
export function CredentialsDialog({
  credentials,
  onClose,
}: {
  credentials: { name: string; email: string; password: string } | null;
  onClose: () => void;
}) {
  const t = useTranslations("people.credentials");
  const tc = useTranslations("common");
  const firstName = credentials?.name.split(/\s+/)[0] ?? "";
  return (
    <Dialog open={!!credentials} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { firstName })}
          </DialogDescription>
        </DialogHeader>
        {credentials && (
          <dl
            className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border bg-muted p-3 font-mono text-sm"
            data-testid="credentials"
          >
            <dt className="font-sans text-muted-foreground">
              {t("emailLabel")}
            </dt>
            <dd className="break-all">{credentials.email}</dd>
            <dt className="font-sans text-muted-foreground">
              {t("passwordLabel")}
            </dt>
            <dd className="break-all">{credentials.password}</dd>
          </dl>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              if (!credentials) return;
              await navigator.clipboard?.writeText(
                t("copyText", {
                  email: credentials.email,
                  password: credentials.password,
                }),
              );
              toast(tc("toast.copied"));
            }}
          >
            <Copy aria-hidden="true" />
            {t("copy")}
          </Button>
          <Button onClick={onClose}>{t("done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
