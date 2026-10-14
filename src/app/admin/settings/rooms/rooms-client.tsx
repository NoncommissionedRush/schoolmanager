"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog, FormDialog } from "@/components/admin/dialogs";
import { RadioGroupField, TextField } from "@/components/admin/fields";
import { useMessage } from "@/components/admin/use-message";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { roomSchema } from "@/server/admin/rooms/schema";

import {
  archiveRoomAction,
  deleteRoomAction,
  restoreRoomAction,
  saveRoomAction,
} from "./actions";

type Room = {
  id: string;
  name: string;
  kind: "PHYSICAL" | "ONLINE";
  capacity: number | null;
  meetingUrl: string | null;
  archived: boolean;
  activeSlots: number;
};

export function NewRoomButton({ label }: { label?: string }) {
  const t = useTranslations("rooms");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        {label ?? t("new")}
      </Button>
      <RoomDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function RoomDialog({
  room,
  open,
  onOpenChange,
}: {
  room?: Room;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("rooms");
  const render = useMessage();
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={room ? t("editTitle") : t("newTitle")}
      submitLabel={room ? t("editSubmit") : t("create")}
      schema={roomSchema}
      action={(previous, formData) =>
        saveRoomAction(room?.id ?? null, previous, formData)
      }
      onSuccess={(data) => {
        for (const warning of data.warnings) toast.warning(render(warning));
      }}
    >
      <RoomFields room={room} />
    </FormDialog>
  );
}

/** Mounted on every opening, so the kind starts from the saved value. */
function RoomFields({ room }: { room?: Room }) {
  const t = useTranslations("rooms");
  const [kind, setKind] = useState<string>(room?.kind ?? "PHYSICAL");
  return (
    <>
      <TextField
        name="name"
        label={t("field.name")}
        defaultValue={room?.name}
        autoFocus
      />
      <RadioGroupField
        name="kind"
        legend={t("field.kind")}
        value={kind}
        onChange={setKind}
        options={[
          { value: "PHYSICAL", label: t("kind.physical") },
          { value: "ONLINE", label: t("kind.online") },
        ]}
      />
      <TextField
        name="capacity"
        type="number"
        min={1}
        max={500}
        label={t("field.capacity")}
        optional={kind === "ONLINE"}
        hint={kind === "ONLINE" ? t("field.capacityOnlineHint") : undefined}
        defaultValue={room?.capacity}
      />
      {/* Kept mounted so a typed link survives switching kind (§6.9). */}
      <div hidden={kind !== "ONLINE"}>
        <TextField
          name="meetingUrl"
          type="url"
          label={t("field.meetingUrl")}
          optional
          placeholder={t("field.meetingUrlPlaceholder")}
          defaultValue={room?.meetingUrl}
        />
      </div>
    </>
  );
}

export function RoomRowActions({ room }: { room: Room }) {
  const t = useTranslations("rooms");
  const tc = useTranslations("common");
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
              aria-label={tc("actionsFor", { name: room.name })}
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
          {room.archived ? (
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
            onClick={() => setDialog("delete")}
          >
            {tc("delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RoomDialog room={room} open={dialog === "edit"} onOpenChange={close} />
      <ConfirmDialog
        open={dialog === "archive"}
        onOpenChange={close}
        title={t("archive.title", { name: room.name })}
        description={
          room.activeSlots > 0 ? (
            <>
              <p>
                {t("archive.slotsKeepRunning", { count: room.activeSlots })}
              </p>
              <Link
                href={`/admin/timetable?room=${room.id}`}
                className="text-primary underline-offset-4 hover:underline"
              >
                {t("archive.openTimetable")}
              </Link>
            </>
          ) : (
            t("archive.consequence")
          )
        }
        confirmLabel={tc("archive")}
        destructive
        run={() => archiveRoomAction(room.id)}
        onDone={() =>
          toast(tc("toast.archived", { name: room.name }), {
            duration: 10_000,
            action: {
              label: tc("undo"),
              onClick: () => void restoreRoomAction(room.id),
            },
          })
        }
      />
      <ConfirmDialog
        open={dialog === "restore"}
        onOpenChange={close}
        title={tc("confirm.restoreTitle", { name: room.name })}
        confirmLabel={tc("restore")}
        run={() => restoreRoomAction(room.id)}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={close}
        title={tc("confirm.deleteTitle", { name: room.name })}
        description={tc("confirm.irreversible")}
        confirmLabel={tc("delete")}
        destructive
        run={() => deleteRoomAction(room.id)}
      />
    </>
  );
}
