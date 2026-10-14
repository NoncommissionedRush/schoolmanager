import {
  notFound,
  assertFresh,
  audit,
  type SchoolDb,
  type Scope,
} from "../shared";
import type { AbsenceSettingsInput } from "./schema";

export async function getAbsenceSettings(db: SchoolDb) {
  const school = await db.school.findFirst({
    select: {
      timezone: true,
      absenceCutoffMinutes: true,
      makeupCreditValidDays: true,
      updatedAt: true,
    },
  });
  if (!school) throw notFound();
  return school;
}

/**
 * Saves the two settings. They apply from now on: the cutoff is evaluated
 * when an absence is reported, and existing credits keep their `expiresAt`
 * (replacements.md §2). Audited as `school.settings.updated`.
 */
export async function updateAbsenceSettings(
  scope: Scope,
  input: AbsenceSettingsInput,
  expectedUpdatedAt?: string | null,
) {
  const { db, schoolId } = scope;
  const current = await getAbsenceSettings(db);
  assertFresh(current, expectedUpdatedAt);
  const school = await db.school.update({
    where: { id: schoolId },
    data: input,
    select: { updatedAt: true },
  });
  await audit(scope, "school.settings.updated", "School", schoolId, {
    before: {
      absenceCutoffMinutes: current.absenceCutoffMinutes,
      makeupCreditValidDays: current.makeupCreditValidDays,
    },
    after: input,
  });
  return school;
}
