/**
 * Results of admin server actions. Messages travel as i18n keys plus ICU
 * values so the server stays the source of truth for validation while the
 * client renders the copy (docs/design/admin-data.md §5.2).
 */

/** A value inside a message: plain, or itself a message to translate first. */
export type MessageValue = string | number | Message;

/** A translatable message: full key (`namespace.path`) and ICU values. */
export type Message = { key: string; values?: Record<string, MessageValue> };

/** Field name → first error for that field. `_form` holds form-level errors. */
export type FieldErrors = Record<string, Message>;

/** "Can't do that yet" (§5.3 Blocked state): reason, offending records, link. */
export type Blocked = {
  title: Message;
  reason: Message;
  items?: string[];
  link?: { href: string; label: Message };
};

export type ActionResult<T = undefined> =
  | { ok: true; data: T; message?: Message }
  | {
      ok: false;
      fieldErrors?: FieldErrors;
      formError?: Message;
      blocked?: Blocked;
    };

export const msg = (
  key: string,
  values?: Record<string, MessageValue>,
): Message => (values ? { key, values } : { key });

/** A refusal raised inside a service; turned into an `ActionResult`. */
export class AdminError extends Error {
  constructor(
    readonly error: Message,
    /** Form field the error belongs to; form-level when omitted. */
    readonly field?: string,
    readonly blocked?: Blocked,
  ) {
    super(error.key);
    this.name = "AdminError";
  }
}

export function blockedError(blocked: Blocked): AdminError {
  return new AdminError(blocked.reason, undefined, blocked);
}

export function toFailure(error: AdminError): ActionResult<never> {
  if (error.blocked) return { ok: false, blocked: error.blocked };
  return error.field
    ? { ok: false, fieldErrors: { [error.field]: error.error } }
    : { ok: false, formError: error.error };
}

export const ok = <T>(data: T, message?: Message): ActionResult<T> =>
  message ? { ok: true, data, message } : { ok: true, data };
