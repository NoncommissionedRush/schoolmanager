"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { ConfirmDialog, FormDialog } from "@/components/admin/dialogs";
import {
  SelectField,
  TextareaField,
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
import { courseSchema } from "@/server/admin/courses/schema";

import { deleteCourseAction, saveCourseAction } from "./course-actions";

type LevelOption = { id: string; label: string };

type Course = {
  id: string;
  name: string;
  levelId: string;
  description: string | null;
  groups: number;
};

export function NewCourseButton({ levels }: { levels: LevelOption[] }) {
  const t = useTranslations("courses");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        {t("new")}
      </Button>
      <CourseDialog levels={levels} open={open} onOpenChange={setOpen} />
    </>
  );
}

function CourseDialog({
  course,
  levels,
  open,
  onOpenChange,
}: {
  course?: Course;
  levels: LevelOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("courses");
  const tc = useTranslations("common");
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={course ? t("editTitle") : t("newTitle")}
      submitLabel={course ? tc("saveChanges") : t("create")}
      schema={courseSchema}
      action={(previous, formData) =>
        saveCourseAction(course?.id ?? null, previous, formData)
      }
    >
      <TextField
        name="name"
        label={t("field.name")}
        defaultValue={course?.name}
        autoFocus
      />
      <SelectField
        name="levelId"
        label={t("field.level")}
        placeholder={t("field.chooseLevel")}
        defaultValue={course?.levelId}
        options={levels.map((level) => ({
          value: level.id,
          label: level.label,
        }))}
      />
      <TextareaField
        name="description"
        label={t("field.description")}
        optional
        defaultValue={course?.description}
      />
    </FormDialog>
  );
}

export function CourseRowActions({
  course,
  levels,
}: {
  course: Course;
  levels: LevelOption[];
}) {
  const tc = useTranslations("common");
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const close = (open: boolean) => !open && setDialog(null);
  const inUse = course.groups > 0;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tc("actionsFor", { name: course.name })}
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
          <DropdownMenuItem
            variant="destructive"
            disabled={inUse}
            onClick={() => setDialog("delete")}
          >
            <span className="flex flex-col">
              {tc("delete")}
              {inUse && (
                <span className="text-xs text-muted-foreground">
                  {tc("inUse", { count: course.groups })}
                </span>
              )}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CourseDialog
        course={course}
        levels={levels}
        open={dialog === "edit"}
        onOpenChange={close}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={close}
        title={tc("confirm.deleteTitle", { name: course.name })}
        description={tc("confirm.irreversible")}
        confirmLabel={tc("delete")}
        destructive
        run={() => deleteCourseAction(course.id)}
      />
    </>
  );
}
