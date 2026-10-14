// Input validation for the generator's server actions
// (docs/architecture/generator.md §7). The client sends plain JSON; nothing
// here is trusted until it passed these schemas.

import { z } from "zod";

const uuid = z.uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const mode = z.enum(["REPLACE", "FILL", "REPLAN_FROM"]);
const version = z.number().int().min(0);

export const readinessSchema = z.strictObject({
  termId: uuid,
  mode: mode.optional(),
  effectiveFrom: isoDate.optional(),
});

export const groupSkipSchema = z.strictObject({
  termId: uuid,
  groupId: uuid,
  skipped: z.boolean(),
});

export const startRunSchema = z.strictObject({
  termId: uuid,
  mode,
  effectiveFrom: isoDate.optional(),
  keepCurrentTeachers: z.boolean().optional(),
});

export const teacherOptionsSchema = z.strictObject({
  draftId: uuid,
  groupId: uuid,
});

export const saveAssignmentSchema = z.strictObject({
  draftId: uuid,
  version,
  groupId: uuid,
  teacherId: uuid.nullable(),
});

export const lockAssignmentsSchema = z.strictObject({
  draftId: uuid,
  version,
  groupIds: z.array(uuid).min(1).max(500),
  locked: z.boolean(),
});

export const previewApplySchema = z.strictObject({
  draftId: uuid,
  publish: z.boolean(),
});

export const applyDraftSchema = z.strictObject({
  draftId: uuid,
  version,
  acknowledgedConflictKeys: z.array(z.string().max(500)).max(2000),
  publish: z.boolean(),
});

export const idSchema = uuid;
