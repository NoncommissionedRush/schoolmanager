"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog, FormDialog } from "@/components/admin/dialogs";
import {
  RadioGroupField,
  SelectField,
  TextField,
} from "@/components/admin/fields";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GROUP_CAPACITY, groupSchema } from "@/server/admin/groups/schema";

import {
  archiveGroupAction,
  restoreGroupAction,
  saveGroupAction,
} from "./actions";

export type GroupFormOptions = {
  levels: { id: string; label: string; archived: boolean }[];
  courses: { id: string; name: string; levelId: string }[];
  students: {
    id: string;
    name: string;
    email: string;
    levelId: string | null;
    levelCode: string | null;
  }[];
};

export type GroupData = {
  id: string;
  name: string;
  type: "GROUP" | "ONE_ON_ONE";
  levelId: string;
  courseId: string | null;
  capacity: number;
  updatedAt: string;
  lessons: number;
  members: number;
  archived: boolean;
};

export function NewGroupButton({
  options,
  label,
}: {
  options: GroupFormOptions;
  label?: string;
}) {
  const t = useTranslations("groups");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        {label ?? t("new")}
      </Button>
      <GroupDialog options={options} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function GroupDialog({
  group,
  options,
  open,
  onOpenChange,
}: {
  group?: GroupData;
  options: GroupFormOptions;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("groups");
  const tc = useTranslations("common");
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={group ? t("editTitle") : t("newTitle")}
      submitLabel={group ? tc("saveChanges") : t("create")}
      schema={groupSchema}
      action={(previous, formData) =>
        saveGroupAction(group?.id ?? null, previous, formData)
      }
    >
      <GroupFields group={group} options={options} />
    </FormDialog>
  );
}

/**
 * Fields of the group dialog and the Details tab (§6.10): type, name,
 * level, course (pre-selects its level), capacity (fixed 1 for 1-on-1)
 * and — when creating a 1-on-1 — the student, which prefills the name.
 */
export function GroupFields({
  group,
  options,
}: {
  group?: GroupData;
  options: GroupFormOptions;
}) {
  const t = useTranslations("groups");
  const [type, setType] = useState<string>(group?.type ?? "GROUP");
  const [levelId, setLevelId] = useState(group?.levelId ?? "");
  const [name, setName] = useState({ value: group?.name ?? "", version: 0 });
  const [autoName, setAutoName] = useState<string | null>(null);
  const typeLocked = !!group && group.lessons > 0;
  const levels = options.levels.filter(
    (level) => !level.archived || level.id === group?.levelId,
  );

  function pickStudent(studentId: string) {
    const student = options.students.find((s) => s.id === studentId);
    if (!student) return;
    // Prefill "{student} 1-on-1" unless the admin typed their own name.
    if (name.value.trim() === "" || name.value === autoName) {
      const value = t("oneOnOneName", { student: student.name });
      setAutoName(value);
      setName({ value, version: name.version + 1 });
    }
    if (!levelId && student.levelId) setLevelId(student.levelId);
  }

  return (
    <div
      className="contents"
      onInput={(event) => {
        const target = event.target as HTMLInputElement;
        if (target.name === "name")
          setName((current) => ({ ...current, value: target.value }));
      }}
    >
      {group && (
        <input type="hidden" name="updatedAt" value={group.updatedAt} />
      )}
      <RadioGroupField
        name="type"
        legend={t("field.type")}
        value={type}
        onChange={setType}
        disabled={typeLocked}
        hint={typeLocked ? t("field.typeLocked") : undefined}
        options={[
          { value: "GROUP", label: t("type.group") },
          { value: "ONE_ON_ONE", label: t("type.oneOnOne") },
        ]}
      />
      {/* A disabled fieldset doesn't submit its radios. */}
      {typeLocked && <input type="hidden" name="type" value={type} />}
      {type === "ONE_ON_ONE" && !group && (
        <SelectField
          name="studentId"
          label={t("field.student")}
          optional
          placeholder={t("field.noStudent")}
          onChange={pickStudent}
          options={options.students.map((student) => ({
            value: student.id,
            label: student.levelCode
              ? `${student.name} (${student.email}, ${student.levelCode})`
              : `${student.name} (${student.email})`,
          }))}
        />
      )}
      <TextField
        key={name.version}
        name="name"
        label={t("field.name")}
        defaultValue={name.value}
        autoFocus={!group}
      />
      <SelectField
        name="courseId"
        label={t("field.course")}
        optional
        placeholder={t("field.noCourse")}
        defaultValue={group?.courseId}
        onChange={(courseId) => {
          const course = options.courses.find((c) => c.id === courseId);
          if (course && levels.some((level) => level.id === course.levelId)) {
            setLevelId(course.levelId);
          }
        }}
        options={options.courses.map((course) => ({
          value: course.id,
          label: course.name,
        }))}
      />
      <SelectField
        name="levelId"
        label={t("field.level")}
        placeholder={t("field.chooseLevel")}
        value={levelId}
        onChange={setLevelId}
        options={levels.map((level) => ({
          value: level.id,
          label: level.label,
        }))}
      />
      {type === "ONE_ON_ONE" ? (
        <TextField
          key="one"
          name="capacity"
          type="number"
          label={t("field.capacity")}
          defaultValue={1}
          readOnly
          hint={t("field.capacityOneOnOne")}
        />
      ) : (
        <TextField
          key="group"
          name="capacity"
          type="number"
          min={GROUP_CAPACITY.min}
          max={GROUP_CAPACITY.max}
          label={t("field.capacity")}
          defaultValue={group?.type === "GROUP" ? group.capacity : undefined}
        />
      )}
    </div>
  );
}

export function GroupRowActions({
  group,
  options,
}: {
  group: GroupData;
  options: GroupFormOptions;
}) {
  const t = useTranslations("groups");
  const tc = useTranslations("common");
  const router = useRouter();
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
              variant="ghost"
              size="icon-sm"
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
          <DropdownMenuItem
            onClick={() => router.push(`/admin/groups/${group.id}`)}
          >
            {t("manageMembers")}
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

/** Archive (blocked while slots run, §5.3) with Undo, and Restore. */
export function GroupArchiveDialogs({
  group,
  dialog,
  onOpenChange,
}: {
  group: { id: string; name: string };
  dialog: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("groups");
  const tc = useTranslations("common");
  return (
    <>
      <ConfirmDialog
        open={dialog === "archive"}
        onOpenChange={onOpenChange}
        title={tc("confirm.archiveTitle", { name: group.name })}
        description={t("archive.consequence")}
        confirmLabel={tc("archive")}
        destructive
        run={() => archiveGroupAction(group.id)}
        onDone={() =>
          toast(tc("toast.archived", { name: group.name }), {
            duration: 10_000,
            action: {
              label: tc("undo"),
              onClick: () => void restoreGroupAction(group.id),
            },
          })
        }
      />
      <ConfirmDialog
        open={dialog === "restore"}
        onOpenChange={onOpenChange}
        title={tc("confirm.restoreTitle", { name: group.name })}
        confirmLabel={tc("restore")}
        run={() => restoreGroupAction(group.id)}
      />
    </>
  );
}
