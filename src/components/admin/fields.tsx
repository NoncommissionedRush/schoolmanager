"use client";

import { Eye, EyeOff, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { generatePassword } from "@/server/admin/password";

import { useFormState } from "./form";
import { useMessage } from "./use-message";

function useField(name: string) {
  const id = useId();
  const render = useMessage();
  const { errors, validateField } = useFormState();
  const error = errors[name] ? render(errors[name]) : null;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return { id, error, errorId, hintId, validate: () => validateField(name) };
}

function FieldShell({
  id,
  label,
  optional,
  hint,
  hintId,
  error,
  errorId,
  children,
}: {
  id: string;
  label: ReactNode;
  optional?: boolean;
  hint?: ReactNode;
  hintId: string;
  error: string | null;
  errorId: string;
  children: ReactNode;
}) {
  const t = useTranslations("common");
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>
        {label}
        {optional && (
          <span className="font-normal text-muted-foreground">
            {t("optional")}
          </span>
        )}
      </Label>
      {children}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

const describedBy = (
  ids: { error: string | null; errorId: string; hintId: string },
  hint: unknown,
) =>
  [ids.error ? ids.errorId : null, hint ? ids.hintId : null]
    .filter(Boolean)
    .join(" ") || undefined;

export function TextField({
  name,
  label,
  defaultValue,
  type = "text",
  hint,
  optional,
  autoFocus,
  placeholder,
  autoComplete = "off",
  min,
  max,
  readOnly,
}: {
  name: string;
  label: ReactNode;
  defaultValue?: string | number | null;
  type?: "text" | "email" | "number" | "date" | "time" | "url" | "tel";
  hint?: ReactNode;
  optional?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  autoComplete?: string;
  min?: number | string;
  max?: number | string;
  readOnly?: boolean;
}) {
  const field = useField(name);
  return (
    <FieldShell {...field} label={label} optional={optional} hint={hint}>
      <Input
        id={field.id}
        name={name}
        type={type}
        defaultValue={defaultValue ?? undefined}
        autoFocus={autoFocus}
        placeholder={placeholder}
        autoComplete={autoComplete}
        min={min}
        max={max}
        readOnly={readOnly}
        aria-invalid={!!field.error}
        aria-describedby={describedBy(field, hint)}
        onBlur={field.validate}
      />
    </FieldShell>
  );
}

export function TextareaField({
  name,
  label,
  defaultValue,
  optional,
  hint,
}: {
  name: string;
  label: ReactNode;
  defaultValue?: string | null;
  optional?: boolean;
  hint?: ReactNode;
}) {
  const field = useField(name);
  return (
    <FieldShell {...field} label={label} optional={optional} hint={hint}>
      <Textarea
        id={field.id}
        name={name}
        defaultValue={defaultValue ?? undefined}
        aria-invalid={!!field.error}
        aria-describedby={describedBy(field, hint)}
        onBlur={field.validate}
      />
    </FieldShell>
  );
}

export type SelectOption = { value: string; label: string };

export function SelectField({
  name,
  label,
  options,
  defaultValue,
  placeholder,
  optional,
  hint,
  onChange,
  value,
  disabled,
}: {
  name: string;
  label: ReactNode;
  options: SelectOption[];
  defaultValue?: string | null;
  /** Empty first option, e.g. "No level". */
  placeholder?: string;
  optional?: boolean;
  hint?: ReactNode;
  onChange?: (value: string) => void;
  value?: string;
  disabled?: boolean;
}) {
  const field = useField(name);
  return (
    <FieldShell {...field} label={label} optional={optional} hint={hint}>
      <NativeSelect
        id={field.id}
        name={name}
        className="w-full"
        defaultValue={value === undefined ? (defaultValue ?? "") : undefined}
        value={value}
        disabled={disabled}
        aria-invalid={!!field.error}
        aria-describedby={describedBy(field, hint)}
        onBlur={field.validate}
        onChange={(event) => onChange?.(event.target.value)}
      >
        {placeholder !== undefined && (
          <NativeSelectOption value="">{placeholder}</NativeSelectOption>
        )}
        {options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </FieldShell>
  );
}

/** Password with Generate (12 chars, no ambiguous ones) and show/hide (§5.4). */
export function PasswordField({
  name = "password",
  autoFocus,
}: {
  name?: string;
  autoFocus?: boolean;
}) {
  const t = useTranslations("people");
  const field = useField(name);
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const hint = t("field.passwordHint");
  return (
    <FieldShell {...field} label={t("field.password")} hint={hint}>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            id={field.id}
            name={name}
            type={visible ? "text" : "password"}
            autoComplete="new-password"
            autoFocus={autoFocus}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={!!field.error}
            aria-describedby={describedBy(field, hint)}
            onBlur={field.validate}
            className="pr-9"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-1/2 right-0.5 -translate-y-1/2"
            aria-label={visible ? t("password.hide") : t("password.show")}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? (
              <EyeOff aria-hidden="true" />
            ) : (
              <Eye aria-hidden="true" />
            )}
          </Button>
        </div>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setValue(generatePassword());
            setVisible(true);
          }}
        >
          <Sparkles aria-hidden="true" />
          {t("password.generate")}
        </Button>
      </div>
    </FieldShell>
  );
}

/** Group of checkboxes submitted under one name (e.g. weekdays). */
export function CheckboxGroupField({
  name,
  legend,
  options,
  defaultValues = [],
}: {
  name: string;
  legend: ReactNode;
  options: SelectOption[];
  defaultValues?: string[];
}) {
  const field = useField(name);
  return (
    <fieldset
      className="flex flex-col gap-2"
      aria-describedby={field.error ? field.errorId : undefined}
    >
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-3">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex items-center gap-1.5 text-sm"
          >
            <input
              type="checkbox"
              name={name}
              value={option.value}
              defaultChecked={defaultValues.includes(option.value)}
              className="size-4 accent-primary"
            />
            {option.label}
          </label>
        ))}
      </div>
      {field.error && (
        <p id={field.errorId} className="text-sm text-destructive">
          {field.error}
        </p>
      )}
    </fieldset>
  );
}

/** Radio group submitted under one name. */
export function RadioGroupField({
  name,
  legend,
  options,
  value,
  onChange,
  disabled,
  hint,
}: {
  name: string;
  legend: ReactNode;
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  const field = useField(name);
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-4">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex items-center gap-1.5 text-sm"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="size-4 accent-primary"
            />
            {option.label}
          </label>
        ))}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {field.error && <p className="text-sm text-destructive">{field.error}</p>}
    </fieldset>
  );
}
