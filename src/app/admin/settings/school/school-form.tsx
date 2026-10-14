"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { AdminForm, SubmitButton } from "@/components/admin/form";
import {
  CheckboxGroupField,
  SelectField,
  TextField,
} from "@/components/admin/fields";
import { useMessage } from "@/components/admin/use-message";
import { Card, CardContent } from "@/components/ui/card";
import { schoolSettingsSchema } from "@/server/admin/school/schema";

import { saveSchoolSettingsAction } from "./actions";

type School = {
  name: string;
  timezone: string;
  timezoneLocked: boolean;
  teachingWeekdays: string[];
  dayStart: string;
  dayEnd: string;
  updatedAt: string;
};

export function SchoolSettingsForm({
  school,
  timezones,
  weekdays,
}: {
  school: School;
  timezones: string[];
  weekdays: { value: string; label: string }[];
}) {
  const t = useTranslations("settings.school");
  const render = useMessage();
  return (
    <Card>
      <CardContent>
        <AdminForm
          action={saveSchoolSettingsAction}
          schema={schoolSettingsSchema}
          onSuccess={(result) => {
            if (result.message) toast.success(render(result.message));
          }}
          footer={(pending) => (
            <div className="flex justify-end">
              <SubmitButton pending={pending}>{t("save")}</SubmitButton>
            </div>
          )}
        >
          <input type="hidden" name="updatedAt" value={school.updatedAt} />
          <TextField name="name" label={t("name")} defaultValue={school.name} />
          {school.timezoneLocked && (
            // A disabled select isn't submitted; the server keeps it anyway.
            <input type="hidden" name="timezone" value={school.timezone} />
          )}
          <SelectField
            name={school.timezoneLocked ? "timezoneDisplay" : "timezone"}
            label={t("timezone")}
            defaultValue={school.timezone}
            disabled={school.timezoneLocked}
            hint={school.timezoneLocked ? t("timezoneLocked") : undefined}
            options={timezones.map((zone) => ({
              value: zone,
              label: zone.replaceAll("_", " "),
            }))}
          />
          <CheckboxGroupField
            name="teachingWeekdays"
            legend={t("week")}
            options={weekdays}
            defaultValues={school.teachingWeekdays}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t("hours")}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                name="dayStartMinute"
                type="time"
                label={t("from")}
                defaultValue={school.dayStart}
              />
              <TextField
                name="dayEndMinute"
                type="time"
                label={t("to")}
                defaultValue={school.dayEnd}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t("hoursHint")}</p>
          </fieldset>
        </AdminForm>
      </CardContent>
    </Card>
  );
}
