import { z } from "zod";

import {
  ABSENCE_CUTOFF_MINUTES_MAX,
  MAKEUP_CREDIT_VALID_DAYS_MAX,
  MAKEUP_CREDIT_VALID_DAYS_MIN,
} from "@/server/scheduling/replacements";

import { integer } from "../validation";

/**
 * Settings › Absences & credits (absences.md §7.1): the cutoff in whole
 * hours (stored in minutes) and the credit validity in days.
 */
export const absenceSettingsSchema = z
  .object({
    cutoffHours: integer({ min: 0, max: ABSENCE_CUTOFF_MINUTES_MAX / 60 }),
    validDays: integer({
      min: MAKEUP_CREDIT_VALID_DAYS_MIN,
      max: MAKEUP_CREDIT_VALID_DAYS_MAX,
    }),
  })
  // Both are required, so never null here (`integer` types allow it).
  .transform(({ cutoffHours, validDays }) => ({
    absenceCutoffMinutes: Number(cutoffHours) * 60,
    makeupCreditValidDays: Number(validDays),
  }));

export type AbsenceSettingsInput = z.output<typeof absenceSettingsSchema>;
