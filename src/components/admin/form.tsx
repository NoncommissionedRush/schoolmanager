"use client";

import { CircleAlert, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  createContext,
  type ReactNode,
  useActionState,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { z } from "zod";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ActionResult, FieldErrors } from "@/server/admin/result";
import { formDataToObject, parseInput } from "@/server/admin/validation";

import { useMessage } from "./use-message";

type FormState = {
  errors: FieldErrors;
  pending: boolean;
  validateField: (name: string) => void;
};

const FormContext = createContext<FormState>({
  errors: {},
  pending: false,
  validateField: () => {},
});

export const useFormState = () => useContext(FormContext);

/**
 * A server action taking `(previous, formData)`, e.g.
 * `(previous, formData) => saveRoom(id, previous, formData)` (`bind` loses
 * the result type). `previous` is typed `never` so `T` is inferred from the
 * result alone.
 */
export type FormAction<T> = (
  previous: never,
  formData: FormData,
) => Promise<ActionResult<T>>;

/**
 * Admin form (§5.2): validates with the shared zod schema on blur and on
 * submit, then submits to a server action, which re-validates and is the
 * source of truth. Server field errors map to the same fields; form-level
 * errors show in an alert above the fields. Focuses the first invalid field.
 */
export function AdminForm<T>({
  action,
  schema,
  onSuccess,
  children,
  footer,
  className = "flex flex-col gap-4",
  id,
}: {
  action: FormAction<T>;
  schema?: z.ZodType;
  onSuccess?: (result: Extract<ActionResult<T>, { ok: true }>) => void;
  children: ReactNode;
  footer?: (pending: boolean) => ReactNode;
  className?: string;
  id?: string;
}) {
  const render = useMessage();
  const formRef = useRef<HTMLFormElement>(null);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [state, formAction, pending] = useActionState(
    async (previous: ActionResult<T> | null, formData: FormData) => {
      const result = await action(previous as never, formData);
      setServerErrors(result.ok ? {} : (result.fieldErrors ?? {}));
      if (result.ok) onSuccess?.(result);
      return result;
    },
    null,
  );

  // Focus the first field the server rejected (DOM only, no state).
  useEffect(() => {
    if (state && !state.ok)
      focusFirstInvalid(formRef.current, state.fieldErrors);
  }, [state]);

  const errors = { ...serverErrors, ...clientErrors };

  function validate(): FieldErrors {
    if (!schema || !formRef.current) return {};
    const result = parseInput(
      schema,
      formDataToObject(new FormData(formRef.current)),
    );
    return result.ok ? {} : result.fieldErrors;
  }

  /**
   * On blur: show the field's error if it's invalid, but never clear one —
   * removing an error line shrinks the dialog, and a click on Save that
   * caused the blur would then miss the moved button. Errors clear while
   * typing instead (`clearFixedError`).
   */
  function validateField(name: string) {
    const error = validate()[name];
    if (error) setClientErrors((current) => ({ ...current, [name]: error }));
  }

  function clearFixedError(name: string) {
    if (!errors[name] || validate()[name]) return;
    const without = (current: FieldErrors) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== name),
      );
    setServerErrors(without);
    setClientErrors(without);
  }

  const formError =
    state && !state.ok && !state.fieldErrors ? state.formError : undefined;

  return (
    <FormContext.Provider value={{ errors, pending, validateField }}>
      <form
        id={id}
        ref={formRef}
        action={formAction}
        noValidate
        className={className}
        onChange={(event) => {
          const name = (event.target as unknown as HTMLInputElement).name;
          if (name) clearFixedError(name);
        }}
        onSubmit={(event) => {
          const fieldErrors = validate();
          setClientErrors(fieldErrors);
          if (Object.keys(fieldErrors).length > 0) {
            event.preventDefault();
            focusFirstInvalid(formRef.current, fieldErrors);
          }
        }}
      >
        {formError && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{render(formError)}</AlertDescription>
          </Alert>
        )}
        {errors._form && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{render(errors._form)}</AlertDescription>
          </Alert>
        )}
        <fieldset disabled={pending} className="contents">
          {children}
        </fieldset>
        {footer?.(pending)}
      </form>
    </FormContext.Provider>
  );
}

function focusFirstInvalid(
  form: HTMLFormElement | null,
  errors: FieldErrors | undefined,
) {
  if (!form || !errors) return;
  for (const element of Array.from(form.elements)) {
    const name = (element as HTMLInputElement).name;
    if (name && errors[name]) {
      (element as HTMLElement).focus();
      return;
    }
  }
}

/** Submit button with spinner + "Saving…" while pending. */
export function SubmitButton({
  children,
  pending,
  variant,
  form,
}: {
  children: ReactNode;
  pending: boolean;
  variant?: "default" | "destructive";
  form?: string;
}) {
  const t = useTranslations("common");
  return (
    <Button type="submit" disabled={pending} variant={variant} form={form}>
      {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
      {pending ? t("saving") : children}
    </Button>
  );
}
