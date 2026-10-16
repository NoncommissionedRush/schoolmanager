import { z } from "zod";

import { optionalText } from "@/server/admin/validation";

/** Longest optional reason for a substitute change (audit only, §3.5). */
export const SUBSTITUTE_REASON_MAX = 300;

const base = {
  lessonId: z.uuid(),
  expectedSubstituteId: z.uuid().nullable(),
  expectedStartsAt: z.iso.datetime(),
  acknowledgedKeys: z.array(z.string().max(200)).max(20).default([]),
  reason: optionalText({ max: SUBSTITUTE_REASON_MAX }),
};

/** Assign or change a substitute (§3.5). */
export const assignSubstituteSchema = z.object({
  ...base,
  teacherId: z.uuid(),
});

/** Remove the substitute (§3.5). */
export const removeSubstituteSchema = z.object(base);

export type AssignSubstituteInput = z.input<typeof assignSubstituteSchema>;
export type RemoveSubstituteInput = z.input<typeof removeSubstituteSchema>;

/** Cover a teacher (design §5.2): who and which dates, mark away or not. */
export const coverTeacherSchema = z
  .object({
    teacherId: z.uuid(),
    from: z.iso.date(),
    to: z.iso.date(),
    markAway: z.boolean().default(true),
  })
  .refine((v) => v.from <= v.to, {
    path: ["to"],
    message: JSON.stringify({ key: "validation.dateOrder" }),
  });

export type CoverTeacherInput = z.input<typeof coverTeacherSchema>;
