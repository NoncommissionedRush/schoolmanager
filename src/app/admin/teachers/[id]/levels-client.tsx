"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { useMessage } from "@/components/admin/use-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { MAX_HOURS, levelsUpTo } from "@/server/admin/teachers/levels";

import { saveTeacherLevelsAction } from "../actions";

export type LevelOption = {
  id: string;
  code: string;
  name: string;
  archived: boolean;
};

/** "Levels they teach" + "Max hours a week" on the Profile tab (§5.2). */
export function TeacherLevelsForm({
  teacherId,
  name,
  levels,
  levelIds,
  maxHours,
}: {
  teacherId: string;
  name: string;
  /** In rank order. */
  levels: LevelOption[];
  levelIds: string[];
  maxHours: number | null;
}) {
  const t = useTranslations("teachers.levels");
  const tm = useTranslations("teachers.maxHours");
  const render = useMessage();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState(() => new Set(levelIds));
  const [hours, setHours] = useState(maxHours === null ? "" : String(maxHours));
  const [hoursError, setHoursError] = useState<string | null>(null);
  // Archived levels show only while the teacher still has them.
  const shown = levels.filter((l) => !l.archived || levelIds.includes(l.id));
  const active = levels.filter((l) => !l.archived);

  function toggle(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function save() {
    setHoursError(null);
    const trimmed = hours.trim();
    startTransition(async () => {
      const result = await saveTeacherLevelsAction(teacherId, {
        levelIds: levels.filter((l) => selected.has(l.id)).map((l) => l.id),
        maxHours: trimmed === "" ? null : Number(trimmed),
      });
      if (!result.ok) {
        const error = result.fieldErrors?.maxHours ?? result.formError;
        if (result.fieldErrors?.maxHours) {
          setHoursError(render(result.fieldErrors.maxHours));
        } else if (error) {
          toast.error(render(error));
        }
        return;
      }
      if (result.message) toast.success(render(result.message));
    });
  }

  return (
    <section
      aria-labelledby="teacher-levels-title"
      className="flex flex-col gap-4"
      data-testid="teacher-levels"
    >
      <fieldset className="flex flex-col gap-3">
        <legend
          id="teacher-levels-title"
          className="mb-2 text-base font-medium"
        >
          {t("title")}
        </legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {shown.map((level) => (
            <label key={level.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={selected.has(level.id)}
                onChange={(e) => toggle(level.id, e.target.checked)}
              />
              <span className="font-medium">{level.code}</span>
              <span className="text-muted-foreground">{level.name}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("quickSelect")}</span>
          <NativeSelect
            size="sm"
            aria-label={t("upTo")}
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              setSelected(new Set(levelsUpTo(active, e.target.value)));
            }}
          >
            <NativeSelectOption value="">{t("upTo")}</NativeSelectOption>
            {active.map((level) => (
              <NativeSelectOption key={level.id} value={level.id}>
                {t("upToLevel", { level: level.code })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setSelected(new Set(active.map((l) => l.id)))}
          >
            {t("all")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setSelected(new Set())}
          >
            {t("none")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t("help", { name })}</p>
      </fieldset>
      <div className="flex max-w-xs flex-col gap-1.5">
        <Label htmlFor="teacher-max-hours">{tm("label")}</Label>
        <Input
          id="teacher-max-hours"
          type="number"
          inputMode="decimal"
          min={MAX_HOURS.min}
          max={MAX_HOURS.max}
          step={0.25}
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          aria-invalid={hoursError ? true : undefined}
          aria-describedby="teacher-max-hours-help"
        />
        <p
          id="teacher-max-hours-help"
          className="text-sm text-muted-foreground"
        >
          {tm("help")}
        </p>
        {hoursError && <p className="text-sm text-destructive">{hoursError}</p>}
      </div>
      <div>
        <Button type="button" onClick={save} disabled={pending}>
          {t("save")}
        </Button>
      </div>
    </section>
  );
}
