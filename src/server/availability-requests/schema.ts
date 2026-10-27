import { z } from "zod";

import { MAX_EXCEPTION_DAYS } from "@/server/admin/availability/rules";
import type {
  ExceptionInput,
  WeeklyInput,
} from "@/server/admin/availability/schema";
import { optionalText } from "@/server/admin/validation";

/**
 * Availability change requests (docs/design/availability-requests.md). The
 * forms are the admin ones (`weeklySchema`, `exceptionSchema`); this file
 * holds what is stored in `AvailabilityRequest.payload` and the admin's
 * rejection note.
 */

const minute = z.number().int().min(0).max(1440);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const note = z.string().nullable();

/** The rule an edit or delete is about, as it was when the teacher asked. */
export const ruleSnapshotSchema = z.object({
  kind: z.enum(["WEEKLY_UNAVAILABLE", "DATE_UNAVAILABLE", "DATE_AVAILABLE"]),
  weekday: z.number().int().min(1).max(7).nullable(),
  date: isoDay.nullable(),
  startMinute: minute.nullable(),
  endMinute: minute.nullable(),
  note,
});
export type RuleSnapshot = z.output<typeof ruleSnapshotSchema>;

const weeklyPayload = z.object({
  weekdays: z.array(z.number().int().min(1).max(7)).min(1),
  startMinute: minute,
  endMinute: minute,
  note,
});

const exceptionPayload = z.object({
  kind: z.enum(["DATE_UNAVAILABLE", "DATE_AVAILABLE"]),
  dates: z.array(isoDay).min(1).max(MAX_EXCEPTION_DAYS),
  window: z.object({ startMinute: minute, endMinute: minute }).nullable(),
  note,
});

export type RequestPayload =
  | { kind: "ADD_WEEKLY"; weekly: WeeklyInput }
  | { kind: "EDIT_WEEKLY"; weekly: WeeklyInput; target: RuleSnapshot }
  | { kind: "ADD_EXCEPTION"; exception: ExceptionInput }
  | { kind: "DELETE_RULE"; target: RuleSnapshot };

const payloadSchemas = {
  ADD_WEEKLY: z.object({ weekly: weeklyPayload }),
  EDIT_WEEKLY: z.object({ weekly: weeklyPayload, target: ruleSnapshotSchema }),
  ADD_EXCEPTION: z.object({ exception: exceptionPayload }),
  DELETE_RULE: z.object({ target: ruleSnapshotSchema }),
} as const;

/** Reads a stored payload back; a row we didn't write is a bug, so it throws. */
export function parsePayload(
  kind: RequestPayload["kind"],
  payload: unknown,
): RequestPayload {
  return { kind, ...payloadSchemas[kind].parse(payload) } as RequestPayload;
}

/** The JSON stored for a payload (the `kind` lives in its own column). */
export function payloadJson(payload: RequestPayload) {
  return JSON.parse(JSON.stringify({ ...payload, kind: undefined }));
}

/** Decided requests stay on the teacher's page this long. */
export const RECENT_DECISION_DAYS = 30;

export type RequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";

/** A request as the availability pages show it. */
export type RequestView = RequestPayload & {
  id: string;
  targetId: string | null;
  status: RequestStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
};

export const rejectSchema = z.object({
  note: optionalText({ max: 200 }),
});
