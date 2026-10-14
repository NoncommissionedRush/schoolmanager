import { toIsoDate } from "@/server/scheduling";
import {
  deleteHoliday as deleteHolidayAndSync,
  saveHoliday as saveHolidayAndSync,
} from "@/server/timetable/service";

import { notFound, type SchoolDb, type Scope } from "../shared";
import type { HolidayFormInput } from "./schema";

/** `school` = school-wide only, a term id = that term's own holidays. */
export type HolidayScopeFilter = "school" | string | null;

/** Holidays card (§6.8), by first day. Dates as `YYYY-MM-DD`. */
export async function listHolidays(db: SchoolDb, filter: HolidayScopeFilter) {
  const holidays = await db.holiday.findMany({
    where:
      filter === "school" ? { termId: null } : filter ? { termId: filter } : {},
    orderBy: [{ startDate: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      termId: true,
    },
  });
  return holidays.map((h) => ({
    ...h,
    startDate: toIsoDate(h.startDate),
    endDate: toIsoDate(h.endDate),
  }));
}

/**
 * Creates or updates a holiday through the timetable service, which
 * reconciles the lessons of every published term it touches (scheduling.md).
 */
export async function saveHoliday(
  scope: Scope,
  id: string | null,
  input: HolidayFormInput,
) {
  const { holidayId, lessons } = await saveHolidayAndSync(
    scope.db,
    scope.actor,
    { holidayId: id ?? undefined, holiday: input },
  );
  return { id: holidayId, name: input.name, lessons };
}

export async function deleteHoliday(scope: Scope, id: string) {
  const holiday = await scope.db.holiday.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!holiday) throw notFound();
  const lessons = await deleteHolidayAndSync(scope.db, scope.actor, id);
  return { ...holiday, lessons };
}
