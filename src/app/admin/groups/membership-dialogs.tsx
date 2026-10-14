"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormDialog } from "@/components/admin/dialogs";
import { SelectField, TextField } from "@/components/admin/fields";
import { Label } from "@/components/ui/label";
import { type GroupOption, joinableGroups } from "@/server/admin/groups/rules";
import {
  addToGroupSchema,
  removeMemberSchema,
} from "@/server/admin/groups/schema";

import { addToGroupAction, removeMemberAction } from "./actions";

export type { GroupOption };

export function useGroupOptionLabel() {
  const t = useTranslations("groups");
  return (group: GroupOption) =>
    t("option", {
      name: group.name,
      level: group.levelCode,
      count: group.members,
      capacity: group.capacity,
    });
}

export function ShowAllLevels({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <Label className="font-normal">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-primary"
      />
      {label}
    </Label>
  );
}

export type StudentRef = {
  id: string;
  name: string;
  levelId: string | null;
  /** Groups the student is currently in. */
  groupIds: string[];
};

/** "Add {name} to a group": group picker + first day (§6.6). */
export function AddToGroupDialog({
  student,
  groups,
  today,
  open,
  onOpenChange,
}: {
  student: StudentRef;
  groups: GroupOption[];
  today: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("students");
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("groups.addTitle", { name: student.name })}
      submitLabel={t("groups.addSubmit")}
      schema={addToGroupSchema}
      action={(previous, formData) =>
        addToGroupAction(student.id, previous, formData)
      }
    >
      <GroupPicker student={student} groups={groups} />
      <TextField
        name="startDate"
        type="date"
        label={t("groups.joined")}
        defaultValue={today}
      />
    </FormDialog>
  );
}

function GroupPicker({
  student,
  groups,
}: {
  student: StudentRef;
  groups: GroupOption[];
}) {
  const t = useTranslations("students");
  const label = useGroupOptionLabel();
  const [showAll, setShowAll] = useState(!student.levelId);
  const options = joinableGroups(groups, {
    levelId: student.levelId,
    exclude: student.groupIds,
    showAll,
  });
  return (
    <div className="flex flex-col gap-2">
      <SelectField
        name="groupId"
        label={t("field.group")}
        placeholder={t("field.chooseGroup")}
        options={options.map((group) => ({
          value: group.id,
          label: label(group),
        }))}
        hint={options.length === 0 ? t("groups.noneAvailable") : undefined}
      />
      {student.levelId && (
        <ShowAllLevels
          checked={showAll}
          onChange={setShowAll}
          label={t("field.showAllLevels")}
        />
      )}
    </div>
  );
}

/** "Remove {name} from {group}?" with the last day (default today). */
export function RemoveMemberDialog({
  membershipId,
  studentName,
  groupName,
  today,
  open,
  onOpenChange,
}: {
  membershipId: string;
  studentName: string;
  groupName: string;
  today: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("groups.members");
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("removeTitle", { name: studentName, group: groupName })}
      submitLabel={t("remove")}
      schema={removeMemberSchema}
      action={(previous, formData) =>
        removeMemberAction(membershipId, previous, formData)
      }
    >
      <TextField
        name="date"
        type="date"
        label={t("removeDate")}
        defaultValue={today}
        max={today}
        autoFocus
      />
    </FormDialog>
  );
}
