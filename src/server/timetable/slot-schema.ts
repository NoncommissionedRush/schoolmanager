// Input validation for the editor's server actions. The client sends plain
// JSON; nothing here is trusted until it passed these schemas.

import { z } from "zod";

const uuid = z.uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const slotRequestSchema = z
  .object({
    slotId: uuid.optional(),
    slot: z.strictObject({
      termId: uuid,
      groupId: uuid,
      teacherId: uuid,
      roomId: uuid.nullable(),
      weekday: z.number().int().min(1).max(7),
      startMinute: z
        .number()
        .int()
        .min(0)
        .max(24 * 60),
      endMinute: z
        .number()
        .int()
        .min(0)
        .max(24 * 60),
    }),
    effectiveFrom: isoDate.optional(),
  })
  .strict();

export type SlotRequestInput = z.infer<typeof slotRequestSchema>;

export const saveSlotSchema = slotRequestSchema
  .extend({
    acknowledgedConflictKeys: z.array(z.string().max(500)).max(200),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export type SaveSlotInput = z.infer<typeof saveSlotSchema>;

export const endSlotSchema = z
  .object({ slotId: uuid, lastDate: isoDate })
  .strict();

export const idSchema = uuid;
