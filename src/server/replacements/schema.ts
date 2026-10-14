import { z } from "zod";

import { optionalText } from "@/server/admin/validation";

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
