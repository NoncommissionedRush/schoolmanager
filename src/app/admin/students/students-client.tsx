"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import {
  ArchivePersonDialog,
  RestorePersonDialog,
  SetPasswordDialog,
} from "@/app/admin/_people/person-dialogs";
import type { Credentials } from "@/app/admin/_people/actions";
import {
  AddToGroupDialog,
  type GroupOption,
  ShowAllLevels,
  useGroupOptionLabel,
} from "@/app/admin/groups/membership-dialogs";
import { CredentialsDialog, FormDialog } from "@/components/admin/dialogs";
import {
  PasswordField,
  SelectField,
  TextField,
} from "@/components/admin/fields";
import { useMessage } from "@/components/admin/use-message";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { joinableGroups } from "@/server/admin/groups/rules";
import { createStudentSchema } from "@/server/admin/people/schema";

import { createStudentAction } from "./actions";

export type LevelOption = { id: string; label: string };

export function NewStudentButton({
  levels,
  groups,
  label,
}: {
  levels: LevelOption[];
  groups: GroupOption[];
  label?: string;
}) {
  const t = useTranslations("students");
  const tp = useTranslations("people");
  const render = useMessage();
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
        schema={createStudentSchema}
        action={createStudentAction}
        onSuccess={(data) => {
          for (const warning of data.warnings) toast.warning(render(warning));
          setCredentials(data);
        }}
      >
        <TextField name="name" label={tp("field.name")} autoFocus />
        <TextField
          name="email"
          type="email"
          label={tp("field.email")}
          autoComplete="off"
        />
        <PasswordField />
        <LevelAndGroupFields levels={levels} groups={groups} />
        <TextField name="phone" type="tel" label={t("field.phone")} optional />
      </FormDialog>
      <CredentialsDialog
        credentials={credentials}
        onClose={() => setCredentials(null)}
      />
    </>
  );
}

/** Level, then a group of that level with free places (§6.6). */
function LevelAndGroupFields({
  levels,
  groups,
}: {
  levels: LevelOption[];
  groups: GroupOption[];
}) {
  const t = useTranslations("students");
  const label = useGroupOptionLabel();
  const [levelId, setLevelId] = useState("");
  const [showAll, setShowAll] = useState(false);
  const options = joinableGroups(groups, {
    levelId: levelId || null,
    showAll,
  });
  return (
    <>
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
      <div className="flex flex-col gap-2">
        <SelectField
          name="groupId"
          label={t("field.addToGroup")}
          optional
          placeholder={t("field.noGroup")}
          options={options.map((group) => ({
            value: group.id,
            label: label(group),
          }))}
        />
        {levelId && (
          <ShowAllLevels
            checked={showAll}
            onChange={setShowAll}
            label={t("field.showAllLevels")}
          />
        )}
      </div>
    </>
  );
}

export type StudentRow = {
  id: string;
  userId: string;
  name: string;
  levelId: string | null;
  archived: boolean;
  groupIds: string[];
  groupNames: string[];
};

/** "{firstName} won't be able to sign in" + groups they leave (§5.3). */
export function StudentArchiveConsequences({
  student,
}: {
  student: StudentRow;
}) {
  const t = useTranslations("students");
  const tp = useTranslations("people");
  const firstName = student.name.split(/\s+/)[0];
  return (
    <ul className="list-disc pl-5">
      <li>{tp("archive.consequenceSignIn", { firstName })}</li>
      {student.groupNames.length > 0 && (
        <li>
          {t("archive.leavesGroups", {
            firstName,
            groups: student.groupNames.join(", "),
          })}
        </li>
      )}
      <li>{tp("archive.consequenceHistory")}</li>
    </ul>
  );
}

export function StudentRowActions({
  student,
  groups,
  today,
}: {
  student: StudentRow;
  groups: GroupOption[];
  today: string;
}) {
  const tc = useTranslations("common");
  const t = useTranslations("students");
  const tp = useTranslations("people");
  const router = useRouter();
  const [dialog, setDialog] = useState<
    "group" | "password" | "archive" | "restore" | null
  >(null);
  const close = (open: boolean) => !open && setDialog(null);
  const person = { userId: student.userId, name: student.name };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tc("actionsFor", { name: student.name })}
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => router.push(`/admin/students/${student.id}`)}
          >
            {tc("edit")}
          </DropdownMenuItem>
          {!student.archived && (
            <DropdownMenuItem onClick={() => setDialog("group")}>
              {t("groups.add")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setDialog("password")}>
            {tp("password.setNew")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
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

      <AddToGroupDialog
        student={student}
        groups={groups}
        today={today}
        open={dialog === "group"}
        onOpenChange={close}
      />
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
