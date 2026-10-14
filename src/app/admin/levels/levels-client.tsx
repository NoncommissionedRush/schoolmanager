"use client";

import { MoreHorizontal, Plus, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmDialog, FormDialog } from "@/components/admin/dialogs";
import { TextField } from "@/components/admin/fields";
import { useMessage } from "@/components/admin/use-message";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { levelSchema } from "@/server/admin/levels/schema";
import type { ActionResult } from "@/server/admin/result";

import {
  addCefrPresetAction,
  archiveLevelAction,
  deleteLevelAction,
  moveLevelAction,
  restoreLevelAction,
  saveLevelAction,
} from "./actions";

type Level = {
  id: string;
  code: string;
  name: string;
  archived: boolean;
  students: number;
  groups: number;
  /** Students, groups and courses pointing at it (any state). */
  usage: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
};

/** Runs a one-shot action and toasts its message or error. */
function useRunAction() {
  const render = useMessage();
  const [pending, startTransition] = useTransition();
  function run(action: () => Promise<ActionResult<undefined>>) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        if (result.message) toast.success(render(result.message));
      } else {
        toast.error(
          render(
            result.formError ??
              result.blocked?.reason ?? { key: "common.error.unexpected" },
          ),
        );
      }
    });
  }
  return { pending, run };
}

export function NewLevelButton({
  label,
  outline,
}: {
  label?: string;
  outline?: boolean;
}) {
  const t = useTranslations("levels");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={outline ? "outline" : "default"}
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden="true" />
        {label ?? t("new")}
      </Button>
      <LevelDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Empty state: one click adds A1–C2 (§6.7). */
export function PresetButton() {
  const t = useTranslations("levels");
  const { pending, run } = useRunAction();
  return (
    <Button disabled={pending} onClick={() => run(addCefrPresetAction)}>
      <Sparkles aria-hidden="true" />
      {t("empty.preset")}
    </Button>
  );
}

function LevelDialog({
  level,
  open,
  onOpenChange,
}: {
  level?: Level;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("levels");
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={level ? t("editTitle") : t("newTitle")}
      submitLabel={level ? t("editSubmit") : t("create")}
      schema={levelSchema}
      action={(previous, formData) =>
        saveLevelAction(level?.id ?? null, previous, formData)
      }
    >
      <TextField
        name="code"
        label={t("field.code")}
        hint={t("field.codeHint")}
        defaultValue={level?.code}
        autoFocus
      />
      <TextField
        name="name"
        label={t("field.name")}
        defaultValue={level?.name}
      />
    </FormDialog>
  );
}

export function LevelRowActions({ level }: { level: Level }) {
  const t = useTranslations("levels");
  const tc = useTranslations("common");
  const { pending, run } = useRunAction();
  const [dialog, setDialog] = useState<
    "edit" | "archive" | "restore" | "delete" | null
  >(null);
  const close = (open: boolean) => !open && setDialog(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={pending}
              aria-label={tc("actionsFor", { name: level.code })}
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
            disabled={!level.canMoveUp}
            onClick={() => run(() => moveLevelAction(level.id, "up"))}
          >
            {t("moveUp")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!level.canMoveDown}
            onClick={() => run(() => moveLevelAction(level.id, "down"))}
          >
            {t("moveDown")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {level.archived ? (
            <DropdownMenuItem onClick={() => setDialog("restore")}>
              {tc("restore")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => setDialog("archive")}>
              {tc("archive")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            variant="destructive"
            disabled={level.usage > 0}
            onClick={() => setDialog("delete")}
          >
            <span className="flex flex-col">
              {tc("delete")}
              {level.usage > 0 && (
                <span className="text-xs text-muted-foreground">
                  {tc("inUse", { count: level.usage })}
                </span>
              )}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <LevelDialog
        level={level}
        open={dialog === "edit"}
        onOpenChange={close}
      />
      <ConfirmDialog
        open={dialog === "archive"}
        onOpenChange={close}
        title={t("archive.title", { code: level.code })}
        description={t("archive.consequence", {
          students: level.students,
          groups: level.groups,
        })}
        confirmLabel={tc("archive")}
        destructive
        run={() => archiveLevelAction(level.id)}
        onDone={() =>
          toast(tc("toast.archived", { name: level.code }), {
            duration: 10_000,
            action: {
              label: tc("undo"),
              onClick: () => void restoreLevelAction(level.id),
            },
          })
        }
      />
      <ConfirmDialog
        open={dialog === "restore"}
        onOpenChange={close}
        title={tc("confirm.restoreTitle", { name: level.code })}
        confirmLabel={tc("restore")}
        run={() => restoreLevelAction(level.id)}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={close}
        title={tc("confirm.deleteTitle", { name: level.code })}
        description={tc("confirm.irreversible")}
        confirmLabel={tc("delete")}
        destructive
        run={() => deleteLevelAction(level.id)}
      />
    </>
  );
}
