import { type Message, msg } from "../result";

export type LessonChanges = {
  created: number;
  removed: number;
  cancelled: number;
};

/**
 * Parts of the shared "lessons changed" toast (timetable.md §5.10): the
 * non-zero counts in order, or "No lessons changed". The client joins them
 * with the locale's list format.
 */
export function lessonChangeParts(changes: LessonChanges): Message[] {
  const parts = (["created", "removed", "cancelled"] as const)
    .filter((part) => changes[part] > 0)
    .map((part) => msg(`terms.result.${part}`, { count: changes[part] }));
  return parts.length > 0 ? parts : [msg("terms.result.none")];
}
