"use client";

import { MoreHorizontal, Plus, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import {
  ArchivePersonDialog,
  RestorePersonDialog,
  SetPasswordDialog,
} from "@/app/admin/_people/person-dialogs";
import {
  AddToGroupDialog,
  type GroupOption,
  RemoveMemberDialog,
} from "@/app/admin/groups/membership-dialogs";
import { AdminForm, SubmitButton } from "@/components/admin/form";
import { SelectField, TextField } from "@/components/admin/fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMessage } from "@/components/admin/use-message";
import { groupsOfOtherLevel } from "@/server/admin/groups/rules";
import { updateStudentSchema } from "@/server/admin/people/schema";

import { updateStudentAction } from "../actions";
import {
  type LevelOption,
  StudentArchiveConsequences,
  type StudentRow,
} from "../students-client";

/** Header: Set new password (outline) + overflow with Archive / Restore. */
export function StudentHeaderActions({ student }: { student: StudentRow }) {
  const tc = useTranslations("common");
  const tp = useTranslations("people");
  const [dialog, setDialog] = useState<
    "password" | "archive" | "restore" | null
  >(null);
  const close = (open: boolean) => !open && setDialog(null);
  const person = { userId: student.userId, name: student.name };
  return (
    <>
      <Button variant="outline" onClick={() => setDialog("password")}>
        {tp("password.setNew")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="icon"
              aria-label={tc("actionsFor", { name: student.name })}
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {student.archived ? (
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
      <SetPasswordDialog
        person={person}
        open={dialog === "password"}
        onOpenChange={close}
      />
      <ArchivePersonDialog
        person={person}
        open={dialog === "archive"}
        onOpenChange={close}
        consequences={<StudentArchiveConsequences student={student} />}
      />
      <RestorePersonDialog
        person={person}
        open={dialog === "restore"}
        onOpenChange={close}
      />
    </>
  );
}

type CurrentGroup = { name: string; levelId: string; levelCode: string };

/** Profile tab (§6.6): name, email, level, phone + level-mismatch warning. */
export function StudentProfileForm({
  student,
  levels,
  currentGroups,
}: {
  student: {
    id: string;
    name: string;
    email: string;
    levelId: string | null;
    phone: string | null;
    updatedAt: string;
  };
  levels: LevelOption[];
  currentGroups: CurrentGroup[];
}) {
  const t = useTranslations("students");
  const tp = useTranslations("people");
  const tc = useTranslations("common");
  const render = useMessage();
  const [levelId, setLevelId] = useState(student.levelId ?? "");
  const mismatched =
    levelId !== (student.levelId ?? "")
      ? groupsOfOtherLevel(levelId || null, currentGroups)
      : [];
  return (
    <AdminForm
      schema={updateStudentSchema}
      action={(previous, formData) =>
        updateStudentAction(student.id, previous, formData)
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
      <input type="hidden" name="updatedAt" value={student.updatedAt} />
      <TextField
        name="name"
        label={tp("field.name")}
        defaultValue={student.name}
      />
      <TextField
        name="email"
        type="email"
        label={tp("field.email")}
        defaultValue={student.email}
      />
      <SelectField
        name="levelId"
        label={t("field.level")}
        optional
        hint={t("field.levelHint")}
        placeholder={t("field.noLevel")}
        value={levelId}
        onChange={setLevelId}
        options={levels.map((level) => ({
          value: level.id,
          label: level.label,
        }))}
      />
      {mismatched.length > 0 && (
        <Alert>
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>
            {mismatched.map((group) => (
              <p key={group.name}>
                {t("levelMismatch", {
                  name: student.name,
                  group: group.name,
                  level: group.levelCode,
                })}
              </p>
            ))}
          </AlertDescription>
        </Alert>
      )}
      <TextField
        name="phone"
        type="tel"
        label={t("field.phone")}
        optional
        defaultValue={student.phone}
      />
    </AdminForm>
  );
}

export function AddToGroupButton({
  student,
  groups,
  today,
}: {
  student: StudentRow;
  groups: GroupOption[];
  today: string;
}) {
  const t = useTranslations("students");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        {t("groups.add")}
      </Button>
      <AddToGroupDialog
        student={student}
        groups={groups}
        today={today}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

export function RemoveMembershipButton({
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
  const t = useTranslations("students");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={t("groups.removeFrom", { group: groupName })}
      >
        {t("groups.remove")}
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
