import { AdminError, msg } from "../result";
import {
  assertFresh,
  audit,
  notFound,
  type SchoolDb,
  type Scope,
} from "../shared";
import type { SchoolSettingsInput } from "./schema";

/** The school row plus whether its time zone is locked (§6.11). */
export async function getSchoolSettings(db: SchoolDb) {
  const [school, lesson] = await Promise.all([
    db.school.findFirst({
      select: {
        id: true,
        name: true,
        timezone: true,
        teachingWeekdays: true,
        dayStartMinute: true,
        dayEndMinute: true,
        updatedAt: true,
      },
    }),
    db.lesson.findFirst({ select: { id: true } }),
  ]);
  if (!school) throw notFound();
  return { ...school, timezoneLocked: !!lesson };
}

/**
 * Saves the school settings. The time zone can't change once any lesson
 * exists: it would shift every lesson. Slots aren't moved when days or
 * hours change; the editor warns about the ones outside.
 */
export async function updateSchoolSettings(
  scope: Scope,
  input: SchoolSettingsInput,
  expectedUpdatedAt?: string | null,
) {
  const { db, schoolId } = scope;
  const current = await getSchoolSettings(db);
  assertFresh(current, expectedUpdatedAt);
  if (current.timezoneLocked && input.timezone !== current.timezone) {
    throw new AdminError(msg("settings.school.timezoneLocked"), "timezone");
  }
  const school = await db.school.update({
    where: { id: schoolId },
    data: input,
    select: { id: true, name: true, updatedAt: true },
  });
  await audit(scope, "school.updated", "School", schoolId, {
    before: {
      name: current.name,
      timezone: current.timezone,
      teachingWeekdays: current.teachingWeekdays,
      dayStartMinute: current.dayStartMinute,
      dayEndMinute: current.dayEndMinute,
    },
    after: input,
  });
  return school;
}
