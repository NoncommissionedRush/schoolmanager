import { z } from "zod";

import { id, optionalText, requiredText } from "../validation";

/** Course dialog (§6.10 Courses tab): name, level, optional description. */
export const courseSchema = z.object({
  name: requiredText({ max: 80 }),
  levelId: id("courses.field.level"),
  description: optionalText({ max: 500 }),
});

export type CourseInput = z.output<typeof courseSchema>;
