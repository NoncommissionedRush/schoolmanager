import { type ListParams, pageWindow, searchWhere, statusWhere } from "../list";
import type { CreateAdminInput } from "../people/schema";
import { createPerson } from "../people/service";
import type { SchoolDb, Scope } from "../shared";

/**
 * Settings › Administrators (§6.12). Archive/restore/password go through
 * the shared people service (self and last-admin rules live there).
 */

export async function listAdmins(db: SchoolDb, filters: ListParams) {
  const where = {
    role: "ADMIN" as const,
    user: statusWhere(filters.status, "deletedAt"),
    ...searchWhere(filters.q, ["user.name", "user.email"]),
  };
  const total = await db.membership.count({ where });
  const window = pageWindow(filters.page, total);
  const [memberships, activeCount] = await Promise.all([
    db.membership.findMany({
      where,
      orderBy: { user: { name: "asc" } },
      skip: window.skip,
      take: window.take,
      select: {
        user: {
          select: { id: true, name: true, email: true, deletedAt: true },
        },
      },
    }),
    db.membership.count({
      where: { role: "ADMIN", user: { deletedAt: null } },
    }),
  ]);
  return {
    admins: memberships.map(({ user }) => ({
      userId: user.id,
      name: user.name,
      email: user.email,
      archived: !!user.deletedAt,
    })),
    total,
    window,
    activeCount,
  };
}

export async function createAdmin(scope: Scope, input: CreateAdminInput) {
  const userId = await createPerson(scope, "ADMIN", input);
  return { userId, name: input.name };
}
