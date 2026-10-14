import { z } from "zod";

import { optionalText, requiredText } from "@/server/admin/validation";

/** Longest cancellation reason (absences.md §5.2, a DB CHECK too). */
export const ABSENCE_REASON_MAX = 300;

/** The cancel dialog (§5.2) and the admin's Report absence dialog (§7.5). */
export const cancelLessonSchema = z.object({
  lessonId: z.string(),
  reason: optionalText({ max: ABSENCE_REASON_MAX }),
  /** The dialog showed "you'll get a credit" (cutoff-passed check). */
  expectCredit: z.boolean().default(false),
});

export const reportAbsenceSchema = cancelLessonSchema.extend({
  studentId: z.string(),
});

export type CancelLessonInput = z.input<typeof cancelLessonSchema>;
export type ReportAbsenceFormInput = z.input<typeof reportAbsenceSchema>;

/** Longest review reason (absences.md §7.3, a DB CHECK too). */
export const REVIEW_NOTE_MAX = 300;

/** Book a replacement (§5.5). */
export const bookReplacementSchema = z.object({
  creditId: z.string(),
  targetLessonId: z.string(),
});

/** Reschedule a 1-on-1 (§5.3): from a lesson or from a credit. */
export const rescheduleSchema = z.union([
  z.object({ lessonId: z.string(), startsAt: z.iso.datetime() }),
  z.object({ creditId: z.string(), startsAt: z.iso.datetime() }),
]);

export const rescheduleSourceSchema = z.union([
  z.object({ lessonId: z.string() }),
  z.object({ creditId: z.string() }),
]);

/** Reject… (§7.3): the student sees the reason. */
export const rejectReplacementSchema = z.object({
  bookingId: z.string(),
  note: requiredText({ max: REVIEW_NOTE_MAX }),
  expectedStatus: z.string().optional(),
});

/** Override… (§7.3): keep (`targetLessonId` null) or move the booking. */
export const overrideReplacementSchema = z.object({
  bookingId: z.string(),
  targetLessonId: z.string().nullable(),
  acknowledgedKeys: z.array(z.string()).max(50).default([]),
  note: requiredText({ max: REVIEW_NOTE_MAX }),
  expectedStatus: z.string().optional(),
});

/** Admin reschedule (replacements.md §7): local date, time and room. */
export const adminRescheduleSchema = z.object({
  lessonId: z.string(),
  date: z.iso.date(),
  startMinute: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 - 1),
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(8 * 60),
  roomId: z.string().nullable(),
  acknowledgedKeys: z.array(z.string()).max(50).default([]),
  note: optionalText({ max: REVIEW_NOTE_MAX }),
});

export type RejectReplacementInput = z.input<typeof rejectReplacementSchema>;
export type OverrideReplacementInput = z.input<
  typeof overrideReplacementSchema
>;
export type AdminRescheduleFormInput = z.input<typeof adminRescheduleSchema>;
