import type { PrismaClient } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { db as globalDb } from "@/lib/db";
import { hashPassword } from "@/server/auth/password";

import { AdminError, blockedError, msg } from "../result";
import {
  activeSlotWhere,
  audit,
  isUniqueViolation,
  notFound,
  type Scope,
} from "../shared";

/**
 * People (teachers, students, admins) share one `User` table, which is
 * global: the school-scoped client may not write it. The functions here
 * first prove through the scoped client that the user belongs to the
 * admin's school (`Membership`), then write `User` with the global client —
 * passed in as `users` so tests can use their own. Nothing else in the admin
 * services touches the global client.
 */

type Users = Pick<PrismaClient, "user" | "$transaction">;

export type NewPerson = { name: string; email: string; password: string };

/** The membership row proving `userId` is in this school with `role`. */
export async function findMember(scope: Scope, userId: string, role?: Role) {
  const membership = await scope.db.membership.findUnique({
    where: { schoolId_userId: { schoolId: scope.schoolId, userId } },
    select: {
      role: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          deletedAt: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!membership || (role && membership.role !== role)) throw notFound();
  return membership;
}

/**
 * Email must be unused (case-insensitive; stored lower-case). An archived
 * account of this school gets "Restore {name} instead" (§6.2).
 */
export async function assertEmailFree(
  scope: Scope,
  email: string,
  exceptUserId?: string,
) {
  const existing = await scope.db.membership.findFirst({
    where: {
      user: { email },
      ...(exceptUserId ? { userId: { not: exceptUserId } } : {}),
    },
    select: { user: { select: { name: true, deletedAt: true } } },
  });
  if (existing?.user.deletedAt) {
    throw new AdminError(
      msg("people.error.emailArchived", { name: existing.user.name }),
      "email",
    );
  }
  if (existing) throw new AdminError(msg("people.error.emailTaken"), "email");
  // Used in another school (User is global, Q2): same message in v1.
  const elsewhere = await globalDb.user.count({
    where: { email, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) },
  });
  if (elsewhere > 0)
    throw new AdminError(msg("people.error.emailTaken"), "email");
}

/**
 * Creates the user, their membership with `role`, and (via `profile`) the
 * role's profile, in one transaction. Returns the new user's id.
 */
export async function createPerson(
  scope: Scope,
  role: Role,
  person: NewPerson,
  profile?: (
    tx: Parameters<Parameters<Users["$transaction"]>[0]>[0],
    userId: string,
  ) => Promise<unknown>,
  users: Users = globalDb,
) {
  await assertEmailFree(scope, person.email);
  const passwordHash = await hashPassword(person.password);
  try {
    const userId = await users.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { name: person.name, email: person.email, passwordHash },
        select: { id: true },
      });
      await tx.membership.create({
        data: { schoolId: scope.schoolId, userId: user.id, role },
      });
      await profile?.(tx, user.id);
      return user.id;
    });
    await audit(scope, "user.created", "User", userId, { role });
    await audit(scope, "user.password_set", "User", userId);
    return userId;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AdminError(msg("people.error.emailTaken"), "email");
    }
    throw error;
  }
}

/** Name and email of a member of this school. */
export async function updatePersonIdentity(
  scope: Scope,
  userId: string,
  identity: { name: string; email: string },
  users: Users = globalDb,
) {
  const member = await findMember(scope, userId);
  if (identity.email !== member.user.email) {
    await assertEmailFree(scope, identity.email, userId);
  }
  try {
    await users.user.update({ where: { id: userId }, data: identity });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AdminError(msg("people.error.emailTaken"), "email");
    }
    throw error;
  }
  return member;
}

/**
 * Sets a new password (§5.4). The password is never logged or audited;
 * the audit row only records who set it for whom. Open sessions stay valid
 * (stateless JWT, owner decision 6).
 */
export async function setPassword(
  scope: Scope,
  userId: string,
  password: string,
  users: Users = globalDb,
) {
  const member = await findMember(scope, userId);
  const passwordHash = await hashPassword(password);
  await users.user.update({ where: { id: userId }, data: { passwordHash } });
  await audit(scope, "user.password_set", "User", userId);
  return member.user;
}

/** When the password was last set (audit log), for the "Sign-in" card. */
export async function lastPasswordChange(scope: Scope, userId: string) {
  const row = await scope.db.auditLog.findFirst({
    where: {
      entityType: "User",
      entityId: userId,
      action: "user.password_set",
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

const formatMinute = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/**
 * Archive rules (§5.3): a teacher with running slots is blocked; a student
 * leaves their groups (`leftAt` = today); an admin can't archive themselves
 * or the last active admin. Sets `User.deletedAt`, which disables sign-in
 * and ends open sessions on the next request.
 */
export async function archivePerson(
  scope: Scope,
  userId: string,
  today: Date,
  users: Users = globalDb,
) {
  const member = await findMember(scope, userId);
  if (member.user.deletedAt) return { user: member.user, leftGroups: [] };
  const { db, schoolId } = scope;
  let leftGroups: string[] = [];

  if (member.role === "TEACHER") {
    const slots = await db.timetableSlot.findMany({
      where: { teacher: { userId }, ...activeSlotWhere(today) },
      select: {
        weekday: true,
        startMinute: true,
        group: { select: { name: true } },
      },
      orderBy: [{ weekday: "asc" }, { startMinute: "asc" }],
    });
    if (slots.length > 0) {
      throw blockedError({
        title: msg("common.blocked.archiveTitle", { name: member.user.name }),
        reason: msg("teachers.blocked.hasSlots", {
          name: member.user.name,
          count: slots.length,
        }),
        items: slots.map((slot) =>
          msg("teachers.blocked.slotItem", {
            group: slot.group.name,
            weekday: msg(`common.weekdayShort.${slot.weekday}`),
            time: formatMinute(slot.startMinute),
          }),
        ),
        link: {
          href: "/admin/timetable",
          label: msg("teachers.blocked.openTimetable"),
        },
      });
    }
  }

  if (member.role === "ADMIN") {
    if (userId === scope.actor.userId) {
      throw new AdminError(msg("admins.error.self"));
    }
    const otherActiveAdmins = await db.membership.count({
      where: {
        role: "ADMIN",
        userId: { not: userId },
        user: { deletedAt: null },
      },
    });
    if (otherActiveAdmins === 0) {
      throw new AdminError(msg("admins.error.lastAdmin"));
    }
  }

  if (member.role === "STUDENT") {
    const memberships = await db.groupMembership.findMany({
      where: { student: { userId }, leftAt: null },
      select: { id: true, group: { select: { name: true } } },
    });
    leftGroups = memberships.map((m) => m.group.name);
    await db.groupMembership.updateMany({
      where: { id: { in: memberships.map((m) => m.id) } },
      data: { leftAt: today },
    });
  }

  await users.user.update({
    where: { id: userId },
    data: { deletedAt: new Date() },
  });
  await audit(scope, "user.archived", "User", userId, { schoolId, leftGroups });
  return { user: member.user, leftGroups };
}

export async function restorePerson(
  scope: Scope,
  userId: string,
  users: Users = globalDb,
) {
  const member = await findMember(scope, userId);
  if (member.user.deletedAt) {
    await users.user.update({
      where: { id: userId },
      data: { deletedAt: null },
    });
    await audit(scope, "user.restored", "User", userId);
  }
  return member.user;
}
