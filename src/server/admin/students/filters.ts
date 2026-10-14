import {
  type ListParams,
  param,
  parseListParams,
  searchWhere,
  statusWhere,
} from "../list";

/**
 * Students list filters (§6.5): search (name, email, phone), level
 * (incl. "No level"), group (incl. "Not in any group") and status.
 */

/** URL value of the "No level" / "Not in any group" options. */
export const NONE = "none";

export type StudentFilters = ListParams & {
  /** Level id, `NONE` or null (any). */
  level: string | null;
  /** Group id, `NONE` or null (any). */
  group: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route params are checked before they reach a `@db.Uuid` column. */
export const isUuid = (value: string) => UUID.test(value);

const idOrNone = (value: string) =>
  value === NONE || isUuid(value) ? value : null;

export function parseStudentFilters(
  params: Record<string, string | string[] | undefined>,
): StudentFilters {
  return {
    ...parseListParams(params),
    level: idOrNone(param(params, "level")),
    group: idOrNone(param(params, "group")),
  };
}

/** A membership that counts: not left, in a group that isn't archived. */
export const CURRENT_MEMBERSHIP = {
  leftAt: null,
  group: { deletedAt: null },
} as const;

/** Prisma `where` for `studentProfile.findMany`. */
export function studentWhere(filters: StudentFilters) {
  const and: Record<string, unknown>[] = [];
  const status = statusWhere(filters.status, "deletedAt");
  if (Object.keys(status).length > 0) and.push({ user: status });
  if (filters.q)
    and.push(searchWhere(filters.q, ["user.name", "user.email", "phone"]));
  if (filters.level === NONE) and.push({ levelId: null });
  else if (filters.level) and.push({ levelId: filters.level });
  if (filters.group === NONE) {
    and.push({ groupMemberships: { none: CURRENT_MEMBERSHIP } });
  } else if (filters.group) {
    and.push({
      groupMemberships: { some: { groupId: filters.group, leftAt: null } },
    });
  }
  return and.length > 0 ? { AND: and } : {};
}
