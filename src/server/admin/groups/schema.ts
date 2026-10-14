import { z } from "zod";

import {
  encodeMessage,
  id,
  integer,
  isoDate,
  issue,
  list,
  optionalId,
  requiredText,
} from "../validation";

export const GROUP_CAPACITY = { min: 1, max: 100 } as const;

/**
 * Group dialog / Details tab (§6.10). A group lesson needs a capacity of
 * 1–100; a 1-on-1 always has capacity 1 and may name its single student
 * at creation.
 */
export const groupSchema = z
  .object({
    type: z.enum(["GROUP", "ONE_ON_ONE"], {
      error: encodeMessage("validation.select", {
        field: { key: "groups.field.type" },
      }),
    }),
    name: requiredText({ max: 80 }),
    levelId: id("groups.field.level"),
    courseId: optionalId(),
    capacity: integer({ ...GROUP_CAPACITY, optional: true }),
    studentId: optionalId(),
    updatedAt: z.string().optional(),
  })
  .superRefine((group, ctx) => {
    if (group.type === "GROUP" && group.capacity === null) {
      issue(ctx, "capacity", "validation.integerRange", GROUP_CAPACITY);
    }
  })
  .transform((group) => ({
    ...group,
    capacity: group.type === "ONE_ON_ONE" ? 1 : (group.capacity ?? 1),
    studentId: group.type === "ONE_ON_ONE" ? group.studentId : null,
  }));

export type GroupInput = z.output<typeof groupSchema>;

/** Add members dialog: one or more students and their first day. */
export const addMembersSchema = z.object({
  studentIds: list(id("groups.field.student")).refine((ids) => ids.length > 0, {
    error: encodeMessage("groups.members.noneSelected"),
  }),
  startDate: isoDate(),
});

/** Add to group (student detail / list): one group and the first day. */
export const addToGroupSchema = z.object({
  groupId: id("students.field.group"),
  startDate: isoDate(),
});

/** Remove from group: the last day in the group. */
export const removeMemberSchema = z.object({ date: isoDate() });
