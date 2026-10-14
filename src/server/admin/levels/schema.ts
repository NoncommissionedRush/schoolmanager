import { z } from "zod";

import { requiredText } from "../validation";

/** Level dialog (§6.7): short code (e.g. "B1") and a name. */
export const levelSchema = z.object({
  code: requiredText({ max: 10 }),
  name: requiredText({ max: 60 }),
});

export type LevelInput = z.output<typeof levelSchema>;
