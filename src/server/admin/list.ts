/**
 * List-page query parameters (§5.1): search, status filter and page live in
 * the URL so a filtered list can be bookmarked and survives a reload.
 */

export const PAGE_SIZE = 25;

export type StatusFilter = "active" | "archived" | "all";

export type ListParams = {
  q: string;
  status: StatusFilter;
  page: number;
};

type SearchParams = Record<string, string | string[] | undefined>;

export function param(params: SearchParams, name: string): string {
  const value = params[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

export function parseListParams(params: SearchParams): ListParams {
  const status = param(params, "status");
  const page = Number.parseInt(param(params, "page"), 10);
  return {
    q: param(params, "q").slice(0, 100),
    status: status === "archived" || status === "all" ? status : "active",
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

/** Prisma filter on a soft-delete column for the status filter. */
export function statusWhere(
  status: StatusFilter,
  column: "deletedAt" | "archivedAt",
) {
  if (status === "all") return {};
  return { [column]: status === "active" ? null : { not: null } };
}

/** `skip`/`take` for a page; clamps to the last page. */
export function pageWindow(page: number, total: number, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(page, pages);
  return {
    page: current,
    pages,
    skip: (current - 1) * size,
    take: size,
    from: total === 0 ? 0 : (current - 1) * size + 1,
    to: Math.min(current * size, total),
  };
}

/** Case-insensitive "contains" on several columns. */
export function searchWhere(q: string, fields: string[]) {
  if (!q) return {};
  return {
    OR: fields.map((field) =>
      nest(field, { contains: q, mode: "insensitive" }),
    ),
  };
}

function nest(path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split(".");
  return { [head]: rest.length ? nest(rest.join("."), value) : value };
}
