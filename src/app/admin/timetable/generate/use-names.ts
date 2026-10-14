"use client";

import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";

import { useDateFormat } from "@/components/timetable/format";
import { lessonTimesLabel } from "@/server/admin/groups/lesson-times";
import { levelRangeLabel } from "@/server/admin/teachers/levels";
import type {
  GroupReasonCode,
  Suggestion,
  TeacherReason,
} from "@/server/scheduling/generator";
import type { GeneratorPageData } from "@/server/timetable/generator-page";

type RawTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** Lookups by id for the page's groups, teachers, levels and rooms. */
export function useNames(data: GeneratorPageData) {
  const tc = useTranslations("common");
  return useMemo(() => {
    const groups = new Map(data.groups.map((g) => [g.id, g]));
    const teachers = new Map(data.teachers.map((t) => [t.id, t]));
    const levels = new Map(data.levels.map((l) => [l.id, l]));
    const rooms = new Map(data.rooms.map((r) => [r.id, r]));
    const weekdayShort = (day: number) =>
      tc(`weekdayShort.${day}` as "weekdayShort.1");
    return {
      groups,
      teachers,
      group: (id: string) => groups.get(id)?.name ?? "—",
      teacher: (id: string | null) =>
        id ? (teachers.get(id)?.name ?? "—") : "—",
      level: (id: string) => levels.get(id)?.code ?? "—",
      room: (id: string | null) => (id ? (rooms.get(id)?.name ?? "—") : "—"),
      weekdayShort,
      /** "Tue, Thu 17:00–18:30". */
      times: (groupId: string) =>
        lessonTimesLabel(groups.get(groupId)?.lessonTimes ?? [], weekdayShort),
      /** Distinct rooms of the group's lesson times. */
      groupRooms: (groupId: string) =>
        [
          ...new Set(
            (groups.get(groupId)?.lessonTimes ?? []).map(
              (t) => rooms.get(t.roomId)?.name ?? "—",
            ),
          ),
        ].join(", "),
      /** "A1–B2" for a teacher. */
      teacherLevels: (teacherId: string) =>
        levelRangeLabel(data.levels, teachers.get(teacherId)?.levelIds ?? []),
    };
  }, [data, tc]);
}

export type Names = ReturnType<typeof useNames>;

/** Messages of the generator's reason codes (`scheduling.generator.*`). */
export function useReasonMessages(names: Names) {
  const t = useTranslations() as unknown as RawTranslate;
  const formatDate = useDateFormat();
  const values = useCallback(
    (params: Record<string, unknown>) => {
      const out: Record<string, string | number> = {};
      for (const [key, value] of Object.entries(params)) {
        if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
          out[key] = formatDate(value, "weekdayDate");
        } else if (typeof value === "string" || typeof value === "number") {
          out[key] = value;
        } else if (typeof value === "boolean") {
          out[key] = value ? "yes" : "no";
        }
      }
      return out;
    },
    [formatDate],
  );
  return useMemo(
    () => ({
      teacherReason: (reason: TeacherReason) =>
        t(
          `scheduling.generator.teacherReasons.${reason.code}`,
          values(reason.params as Record<string, unknown>),
        ),
      groupReason: (reason: GroupReasonCode, params: Record<string, unknown>) =>
        t(`scheduling.generator.reasons.${reason}`, values(params)),
      suggestion: (suggestion: Suggestion, levelId: string) =>
        t(`scheduling.generator.suggestions.${suggestion.kind}`, {
          teacher: names.teacher(suggestion.teacherId),
          level: names.level(levelId),
          ...(suggestion.kind === "SWAP"
            ? {
                otherGroup: names.group(suggestion.otherGroupId),
                otherTeacher: names.teacher(suggestion.otherTeacherId),
              }
            : {}),
        }),
    }),
    [t, values, names],
  );
}
