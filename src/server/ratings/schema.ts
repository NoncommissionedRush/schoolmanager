import { z } from "zod";

import { normalizeComment, RATING_COMMENT_MAX } from "./rules";

const encode = (key: string, values?: Record<string, string | number>) =>
  JSON.stringify(values ? { key, values } : { key });

/** The student's rating form (design §6.4); also the server's check. */
export const saveRatingSchema = z.object({
  teacherId: z.uuid(),
  termId: z.uuid(),
  score: z.preprocess(
    (value) =>
      typeof value === "string" && value !== "" ? Number(value) : value,
    z
      .number({ error: encode("ratings.form.required") })
      .int({ error: encode("ratings.form.required") })
      .min(1, { error: encode("ratings.form.required") })
      .max(5, { error: encode("ratings.form.required") }),
  ),
  // Trimmed, empty → null (§4.2).
  comment: z.preprocess(
    (value) => normalizeComment(typeof value === "string" ? value : null),
    z
      .string()
      .max(RATING_COMMENT_MAX, {
        error: encode("ratings.form.tooLong", { max: RATING_COMMENT_MAX }),
      })
      .nullable(),
  ),
});

export type SaveRatingInput = z.input<typeof saveRatingSchema>;

/** Hide or unhide one rating (admin, §4.2). */
export const hideRatingSchema = z.object({
  ratingId: z.uuid(),
  hidden: z.boolean(),
});

export type HideRatingInput = z.input<typeof hideRatingSchema>;
