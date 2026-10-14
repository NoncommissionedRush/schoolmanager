import { z } from "zod";

import { integer, issue, optionalHttpsUrl, requiredText } from "../validation";

/**
 * Room dialog (§6.9). Physical rooms need a capacity (1–500); online rooms
 * may have a meeting link (https) and an optional capacity. Switching kind
 * keeps typed values in the form, but only the relevant ones are saved.
 */
export const roomSchema = z
  .object({
    name: requiredText({ max: 60 }),
    kind: z.enum(["PHYSICAL", "ONLINE"]),
    capacity: integer({ min: 1, max: 500, optional: true }),
    meetingUrl: optionalHttpsUrl(),
  })
  .superRefine((room, ctx) => {
    if (room.kind === "PHYSICAL" && room.capacity === null) {
      issue(ctx, "capacity", "validation.integerRange", { min: 1, max: 500 });
    }
  })
  .transform((room) => ({
    ...room,
    meetingUrl: room.kind === "ONLINE" ? room.meetingUrl : null,
  }));

export type RoomInput = z.output<typeof roomSchema>;
