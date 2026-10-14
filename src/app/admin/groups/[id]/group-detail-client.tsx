"use client";

import {
  Clock,
  MoreHorizontal,
  Plus,
  Search,
  TriangleAlert,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { FormDialog } from "@/components/admin/dialogs";
import { TextField } from "@/components/admin/fields";
import { AdminForm, SubmitButton, useFormState } from "@/components/admin/form";
import { useMessage } from "@/components/admin/use-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { addMembersSchema, groupSchema } from "@/server/admin/groups/schema";
import type { MemberCandidate } from "@/server/admin/groups/service";

import { addMembersAction, saveGroupAction } from "../actions";
import {
  GroupArchiveDialogs,
  type GroupData,
  GroupDialog,
  GroupFields,
  type GroupFormOptions,
} from "../groups-client";
import { RemoveMemberDialog, ShowAllLevels } from "../membership-dialogs";

/** Header overflow: Edit, Archive / Restore. */
export function GroupHeaderActions({
  group,
  options,
}: {
  group: GroupData;
  options: GroupFormOptions;
}) {
  const tc = useTranslations("common");
  const [dialog, setDialog] = useState<"edit" | "archive" | "restore" | null>(
    null,
  );
  const close = (open: boolean) => !open && setDialog(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="icon"
              aria-label={tc("actionsFor", { name: group.name })}
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
          {group.archived ? (
            <DropdownMenuItem onClick={() => setDialog("restore")}>
              {tc("restore")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setDialog("archive")}
            >
              {tc("archive")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <GroupDialog
        group={group}
        options={options}
        open={dialog === "edit"}
        onOpenChange={close}
      />
      <GroupArchiveDialogs group={group} dialog={dialog} onOpenChange={close} />
    </>
  );
}

/** Details tab: the dialog's fields inline with _Save changes_. */
export function GroupDetailsForm({
  group,
  options,
}: {
  group: GroupData;
  options: GroupFormOptions;
}) {
  const tc = useTranslations("common");
  const render = useMessage();
  return (
    <AdminForm
      schema={groupSchema}
      action={(previous, formData) =>
        saveGroupAction(group.id, previous, formData)
      }
      onSuccess={(result) => {
        if (result.message) toast.success(render(result.message));
      }}
      footer={(pending) => (
        <div>
          <SubmitButton pending={pending}>{tc("saveChanges")}</SubmitButton>
        </div>
      )}
    >
      <GroupFields key={group.updatedAt} group={group} options={options} />
    </AdminForm>
  );
}

export function RemoveMemberButton({
  membershipId,
  studentName,
  groupName,
  today,
}: {
  membershipId: string;
  studentName: string;
  groupName: string;
  today: string;
}) {
  const t = useTranslations("groups.members");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {t("remove")}
        <span className="sr-only">{studentName}</span>
      </Button>
      <RemoveMemberDialog
        membershipId={membershipId}
        studentName={studentName}
        groupName={groupName}
        today={today}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

type GroupRef = {
  id: string;
  name: string;
  levelId: string;
  placesLeft: number;
};

export function AddMembersButton({
  group,
  candidates,
  today,
}: {
  group: GroupRef;
  candidates: MemberCandidate[];
  today: string;
}) {
  const t = useTranslations("groups.members");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        {t("add")}
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t("addTitle", { name: group.name })}
        submitLabel={t("addSubmit")}
        schema={addMembersSchema}
        wide
        action={(previous, formData) =>
          addMembersAction(group.id, previous, formData)
        }
      >
        <MemberPicker group={group} candidates={candidates} />
        <TextField
          name="startDate"
          type="date"
          label={t("startDate")}
          defaultValue={today}
        />
      </FormDialog>
    </>
  );
}

/**
 * Checkbox list with search (§6.10). Defaults to the group's level; never
 * lets the admin select more students than there are free places.
 */
function MemberPicker({
  group,
  candidates,
}: {
  group: GroupRef;
  candidates: MemberCandidate[];
}) {
  const t = useTranslations("groups.members");
  const render = useMessage();
  const { errors } = useFormState();
  const [selected, setSelected] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState("");
  const full = selected.length >= group.placesLeft;
  const query = q.trim().toLowerCase();
  const visible = (student: MemberCandidate) =>
    (showAll || student.levelId === group.levelId) &&
    (!query ||
      student.name.toLowerCase().includes(query) ||
      student.email.toLowerCase().includes(query));
  const shown = candidates.filter(visible);

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm font-medium">{t("students")}</legend>
      <p className="text-sm" role="status">
        {t("placesLeft", {
          count: Math.max(0, group.placesLeft - selected.length),
        })}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label={t("search")}
            placeholder={t("search")}
            value={q}
            className="pl-8"
            onChange={(event) => setQ(event.target.value)}
          />
        </div>
        <ShowAllLevels
          checked={showAll}
          onChange={setShowAll}
          label={t("showAllLevels")}
        />
      </div>
      {full && (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <TriangleAlert aria-hidden="true" className="size-4" />
          {t("full")}
        </p>
      )}
      {errors.studentIds && (
        <p className="text-sm text-destructive">{render(errors.studentIds)}</p>
      )}
      <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border p-2">
        {/* Hidden rows stay mounted so a selection survives filtering. */}
        {candidates.map((student) => {
          const checked = selected.includes(student.id);
          return (
            <li key={student.id} hidden={!visible(student)}>
              <label className="flex flex-wrap items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted has-disabled:opacity-60">
                <input
                  type="checkbox"
                  name="studentIds"
                  value={student.id}
                  checked={checked}
                  disabled={!checked && full}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, student.id]
                        : current.filter((id) => id !== student.id),
                    )
                  }
                  className="size-4 accent-primary"
                />
                <span className="font-medium">{student.name}</span>
                <span className="text-muted-foreground">{student.email}</span>
                {student.otherLevel && student.levelCode && (
                  <Badge variant="destructive">
                    <TriangleAlert aria-hidden="true" />
                    {t("levelTag", { level: student.levelCode })}
                  </Badge>
                )}
                {!student.levelCode && (
                  <Badge variant="outline">{t("noLevelTag")}</Badge>
                )}
                {student.clash && (
                  <Badge variant="destructive">
                    <Clock aria-hidden="true" />
                    {t("timeClash", { group: student.clash })}
                  </Badge>
                )}
              </label>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="px-2 py-1.5 text-sm text-muted-foreground">
            {t("noCandidates")}
          </li>
        )}
      </ul>
    </fieldset>
  );
}
