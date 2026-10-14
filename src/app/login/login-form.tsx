"use client";

import { CircleAlert, Eye, EyeOff, Info, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  validateLoginInput,
  type LoginFieldErrors,
} from "@/server/auth/login-input";

import { login, type LoginState } from "./actions";

const controlClass = "h-11 text-base md:h-9 md:text-sm";

export function LoginForm({
  callbackUrl,
  sessionExpired,
}: {
  callbackUrl: string | null;
  sessionExpired: boolean;
}) {
  const t = useTranslations("auth.login");
  const tv = useTranslations("validation");
  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    login,
    {},
  );
  const [showPassword, setShowPassword] = useState(false);
  const [clientErrors, setClientErrors] = useState<LoginFieldErrors>({});
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const fieldErrors = { ...state.fieldErrors, ...clientErrors };

  // After a failed sign-in the password is cleared and focused (§7.1).
  useEffect(() => {
    if (state.error && passwordRef.current) {
      passwordRef.current.value = "";
      passwordRef.current.focus();
    } else if (state.fieldErrors?.email) emailRef.current?.focus();
    else if (state.fieldErrors?.password) passwordRef.current?.focus();
  }, [state]);

  function validateField(name: "email" | "password") {
    const { errors } = validateLoginInput({
      email: emailRef.current?.value,
      password: passwordRef.current?.value,
    });
    setClientErrors((current) => ({ ...current, [name]: errors?.[name] }));
  }

  function errorText(name: "email" | "password") {
    const error = fieldErrors[name];
    if (!error) return null;
    return error === "email"
      ? tv("email")
      : tv("required", { field: t(name).toLowerCase() });
  }

  const emailError = errorText("email");
  const passwordError = errorText("password");

  return (
    <form
      action={formAction}
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        const { errors } = validateLoginInput({
          email: emailRef.current?.value,
          password: passwordRef.current?.value,
        });
        setClientErrors(errors ?? {});
        if (errors) {
          event.preventDefault();
          (errors.email ? emailRef : passwordRef).current?.focus();
        }
      }}
    >
      {sessionExpired && !state.error && (
        <Alert>
          <Info aria-hidden="true" />
          <AlertDescription className="text-foreground">
            {t("sessionExpired")}
          </AlertDescription>
        </Alert>
      )}
      {state.error && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{t(`error.${state.error}`)}</AlertDescription>
        </Alert>
      )}

      {callbackUrl && (
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">{t("email")}</Label>
        <Input
          ref={emailRef}
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={state.email}
          disabled={pending}
          aria-invalid={!!emailError}
          aria-describedby={emailError ? "email-error" : undefined}
          onBlur={() => validateField("email")}
          className={controlClass}
        />
        {emailError && (
          <p id="email-error" className="text-sm text-destructive">
            {emailError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="password">{t("password")}</Label>
        <div className="relative">
          <Input
            ref={passwordRef}
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            disabled={pending}
            aria-invalid={!!passwordError}
            aria-describedby={passwordError ? "password-error" : undefined}
            onBlur={() => validateField("password")}
            className={`${controlClass} pr-11`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute top-1/2 right-1 size-9 -translate-y-1/2 md:size-7"
            aria-label={showPassword ? t("hidePassword") : t("showPassword")}
            aria-pressed={showPassword}
            onClick={() => setShowPassword((value) => !value)}
          >
            {showPassword ? (
              <EyeOff aria-hidden="true" />
            ) : (
              <Eye aria-hidden="true" />
            )}
          </Button>
        </div>
        {passwordError && (
          <p id="password-error" className="text-sm text-destructive">
            {passwordError}
          </p>
        )}
      </div>

      <Button type="submit" disabled={pending} className="h-11 md:h-9">
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
