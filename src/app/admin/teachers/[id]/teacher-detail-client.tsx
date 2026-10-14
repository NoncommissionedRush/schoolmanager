"use client";

import { MoreHorizontal } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

import { AdminForm, SubmitButton } from "@/components/admin/form";
import { TextareaField, TextField } from "@/components/admin/fields";
import { useMessage } from "@/components/admin/use-message";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type TeacherColor,
  updateTeacherSchema,
} from "@/server/admin/people/schema";

import { updateTeacherAction } from "../actions";
import { ColorSwatchField, TeacherDialogs } from "../teachers-client";
import { TEACHER_TABS, type TeacherTab } from "./tabs";

/** Profile / Availability / Groups; the active tab lives in `?tab=` (§6.3). */
export function TeacherTabs({
  value,
  panels,
}: {
  value: TeacherTab;
  panels: Record<TeacherTab, ReactNode>;
}) {
  const t = useTranslations("teachers.tab");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [tab, setTab] = useState<TeacherTab>(value);
  return (
    <Tabs
      value={tab}
      onValueChange={(next: TeacherTab) => {
        setTab(next);
        const search = new URLSearchParams(params.toString());
        if (next === "profile") search.delete("tab");
        else search.set("tab", next);
        const query = search.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, {
          scroll: false,
        });
      }}
    >
      <TabsList aria-label={t("label")}>
        {TEACHER_TABS.map((name) => (
          <TabsTrigger key={name} value={name}>
            {t(name)}
          </TabsTrigger>
        ))}
      </TabsList>
      {TEACHER_TABS.map((name) => (
        <TabsContent key={name} value={name} className="pt-4">
          {panels[name]}
        </TabsContent>
      ))}
    </Tabs>
  );
}

type Person = { userId: string; name: string };

/** Header: Set new password (outline) + overflow menu with Archive/Restore. */
export function TeacherHeaderActions({
  person,
  archived,
}: {
  person: Person;
  archived: boolean;
}) {
  const t = useTranslations("teachers");
  const tc = useTranslations("common");
  const tp = useTranslations("people");
  const [dialog, setDialog] = useState<
    "password" | "archive" | "restore" | null
  >(null);
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
              aria-label={t("action.more", { name: person.name })}
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {archived ? (
            <DropdownMenuItem onClick={() => setDialog("restore")}>
              {tc("restore")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => setDialog("archive")}>
              {tc("archive")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <TeacherDialogs
        person={person}
        dialog={dialog}
        onOpenChange={(open) => !open && setDialog(null)}
      />
    </>
  );
}

/** "Set new password" in the Sign-in card. */
export function SetPasswordButton({ person }: { person: Person }) {
  const tp = useTranslations("people");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {tp("password.setNew")}
      </Button>
      <TeacherDialogs
        person={person}
        dialog={open ? "password" : null}
        onOpenChange={setOpen}
      />
    </>
  );
}

export function TeacherProfileForm({
  teacher,
}: {
  teacher: {
    id: string;
    name: string;
    email: string;
    bio: string | null;
    colorName: TeacherColor | null;
    updatedAt: string;
  };
}) {
  const t = useTranslations("teachers");
  const tp = useTranslations("people");
  const tc = useTranslations("common");
  const render = useMessage();
  const [updatedAt, setUpdatedAt] = useState(teacher.updatedAt);
  return (
    <AdminForm
      schema={updateTeacherSchema}
      action={(previous, formData) =>
        updateTeacherAction(teacher.id, previous, formData)
      }
      onSuccess={(result) => {
        setUpdatedAt(result.data.updatedAt);
        if (result.message) toast.success(render(result.message));
      }}
      footer={(pending) => (
        <div>
          <SubmitButton pending={pending}>{tc("saveChanges")}</SubmitButton>
        </div>
      )}
    >
      <input type="hidden" name="updatedAt" value={updatedAt} />
      <TextField
        name="name"
        label={tp("field.name")}
        defaultValue={teacher.name}
      />
      <TextField
        name="email"
        type="email"
        label={tp("field.email")}
        defaultValue={teacher.email}
      />
      <ColorSwatchField defaultValue={teacher.colorName} />
      <TextareaField
        name="bio"
        label={t("field.bio")}
        optional
        defaultValue={teacher.bio}
      />
    </AdminForm>
  );
}
