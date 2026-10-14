import { z } from "zod";

import { normalizeEmail } from "@/server/auth/credentials";

import type { FieldErrors, Message, MessageValue } from "./result";

/**
 * Building blocks for the admin forms' zod schemas. They are shared by the
 * client (validate on blur/submit) and the server (source of truth). Error
 * messages are encoded i18n keys; `parseInput` turns them into `FieldErrors`.
 */

const encode = (key: string, values?: Record<string, MessageValue>) =>
  JSON.stringify(values ? { key, values } : { key });

function decode(message: string): Message {
  try {
    const parsed = JSON.parse(message) as Message;
    if (parsed && typeof parsed.key === "string") return parsed;
  } catch {
    // Not one of ours (e.g. a zod default message).
  }
  return { key: "common.error.unexpected" };
}

export type ParseResult<T> =
  { ok: true; data: T } | { ok: false; fieldErrors: FieldErrors };

export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
): ParseResult<z.output<S>> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  const fieldErrors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path.map(String).join(".") || "_form";
    fieldErrors[field] ??= decode(issue.message);
  }
  return { ok: false, fieldErrors };
}

/**
 * FormData → plain object. Repeated keys become arrays; File values are
 * dropped (no uploads in admin forms).
 */
export function formDataToObject(
  formData: FormData,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(formData.keys())) {
    if (key.startsWith("$ACTION")) continue;
    const values = formData
      .getAll(key)
      .filter((value): value is string => typeof value === "string");
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
}

const asString = (value: unknown) =>
  typeof value === "string" ? value.trim() : value;
const emptyToUndefined = (value: unknown) => {
  const trimmed = asString(value);
  return trimmed === "" || trimmed === null ? undefined : trimmed;
};

/** Required text, trimmed. */
export function requiredText({ min = 1, max }: { min?: number; max: number }) {
  return z.preprocess(
    (value) => asString(value ?? ""),
    z
      .string()
      .min(1, { error: encode("validation.requiredField") })
      .min(min, { error: encode("validation.minLength", { min }) })
      .max(max, { error: encode("validation.maxLength", { max }) }),
  );
}

/** Optional text, trimmed; empty → null. */
export function optionalText({ max }: { max: number }) {
  return z.preprocess(
    (value) => emptyToUndefined(value) ?? null,
    z
      .string()
      .max(max, { error: encode("validation.maxLength", { max }) })
      .nullable(),
  );
}

// Deliberately loose, like the login form: "looks like an address".
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Required email, stored lower-case (§9). */
export function email() {
  return z.preprocess(
    (value) => normalizeEmail(typeof value === "string" ? value : ""),
    z
      .string()
      .min(1, { error: encode("validation.requiredField") })
      .max(254, { error: encode("validation.maxLength", { max: 254 }) })
      .regex(EMAIL_PATTERN, { error: encode("validation.email") }),
  );
}

export const PASSWORD_MIN = 10;

/** New password (§5.4): at least 10 characters, not trimmed. */
export function password() {
  return z.preprocess(
    (value) => (typeof value === "string" ? value : ""),
    z
      .string()
      .min(PASSWORD_MIN, { error: encode("validation.passwordMin") })
      .max(200, { error: encode("validation.maxLength", { max: 200 }) }),
  );
}

/** Whole number in a range; empty → required error (or null when optional). */
export function integer({
  min,
  max,
  optional = false,
}: {
  min: number;
  max: number;
  optional?: boolean;
}) {
  const range = encode("validation.integerRange", { min, max });
  const number = z
    .number({ error: range })
    .int({ error: range })
    .min(min, { error: range })
    .max(max, { error: range });
  return z.preprocess(
    (value) => {
      const trimmed = emptyToUndefined(value);
      if (trimmed === undefined) return optional ? null : undefined;
      return typeof trimmed === "string" ? Number(trimmed) : trimmed;
    },
    optional ? number.nullable() : number,
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Required id from a picker; `field` is the i18n key of the field label. */
export function id(field: string) {
  return z.preprocess(
    (value) => emptyToUndefined(value) ?? "",
    z.string().regex(UUID, {
      error: encode("validation.select", { field: { key: field } }),
    }),
  );
}

/** Optional id; empty → null. */
export function optionalId() {
  return z.preprocess(
    (value) => emptyToUndefined(value) ?? null,
    z
      .string()
      .regex(UUID, { error: encode("common.error.unexpected") })
      .nullable(),
  );
}

/** Optional `https://` link (online room meeting links). */
export function optionalHttpsUrl() {
  return z.preprocess(
    (value) => emptyToUndefined(value) ?? null,
    z
      .string()
      .max(500, { error: encode("validation.maxLength", { max: 500 }) })
      .refine(
        (value) => {
          try {
            return new URL(value).protocol === "https:";
          } catch {
            return false;
          }
        },
        { error: encode("validation.url") },
      )
      .nullable(),
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar date `YYYY-MM-DD`. */
export function isoDate() {
  return z.preprocess(
    (value) => emptyToUndefined(value) ?? "",
    z
      .string()
      .min(1, { error: encode("validation.requiredField") })
      .refine(
        (value) =>
          ISO_DATE.test(value) &&
          new Date(`${value}T00:00:00Z`).toISOString().startsWith(value),
        { error: encode("validation.date") },
      ),
  );
}

/** Time of day `HH:MM` → minutes since midnight. */
export function timeOfDay() {
  return z.preprocess(
    (value) => emptyToUndefined(value) ?? "",
    z
      .string()
      .min(1, { error: encode("validation.requiredField") })
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: encode("validation.time") })
      .transform((value) => {
        const [hours, minutes] = value.split(":").map(Number);
        return hours * 60 + minutes;
      }),
  );
}

/** Checkbox: present ("on"/"true") → true. */
export function checkbox() {
  return z.preprocess(
    (value) => value === "on" || value === "true" || value === true,
    z.boolean(),
  );
}

/** Multi-value field (checkbox group); a single value becomes `[value]`. */
export function list<T extends z.ZodType>(item: T) {
  return z.preprocess(
    (value) => (value === undefined || value === "" ? [] : [value].flat()),
    z.array(item),
  );
}

/** Adds an error to `field` from a schema refinement. */
export function issue(
  ctx: z.RefinementCtx,
  field: string,
  key: string,
  values?: Record<string, MessageValue>,
) {
  ctx.addIssue({ code: "custom", path: [field], message: encode(key, values) });
}

export { encode as encodeMessage };
