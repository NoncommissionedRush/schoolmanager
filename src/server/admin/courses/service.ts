import { assertLevelPickable } from "../groups/pickers";
import { blockedError, msg } from "../result";
import {
  audit,
  isUniqueViolation,
  notFound,
  type SchoolDb,
  type Scope,
  uniqueError,
} from "../shared";
import type { CourseInput } from "./schema";

/** Courses tab (§6.10): a simple list, no paging (a school has a handful). */
export async function listCourses(db: SchoolDb) {
  const courses = await db.course.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      levelId: true,
      level: { select: { code: true, archivedAt: true } },
      _count: { select: { groups: true } },
    },
  });
  return courses.map(({ _count, ...course }) => ({
    ...course,
    groups: _count.groups,
  }));
}

async function assertNameFree(db: SchoolDb, name: string, exceptId?: string) {
  const clash = await db.course.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw uniqueError("name", "courses.field.name", name);
}

export async function createCourse(scope: Scope, input: CourseInput) {
  const { db, schoolId } = scope;
  await assertNameFree(db, input.name);
  await assertLevelPickable(db, input.levelId, "levelId");
  try {
    const course = await db.course.create({
      data: { ...input, schoolId },
      select: { id: true, name: true },
    });
    await audit(scope, "course.created", "Course", course.id);
    return course;
  } catch (error) {
    if (isUniqueViolation(error))
      throw uniqueError("name", "courses.field.name", input.name);
    throw error;
  }
}

export async function updateCourse(
  scope: Scope,
  id: string,
  input: CourseInput,
) {
  const { db } = scope;
  const existing = await db.course.findUnique({
    where: { id },
    select: { levelId: true },
  });
  if (!existing) throw notFound();
  await assertNameFree(db, input.name, id);
  await assertLevelPickable(db, input.levelId, "levelId", existing.levelId);
  try {
    const course = await db.course.update({
      where: { id },
      data: input,
      select: { id: true, name: true },
    });
    await audit(scope, "course.updated", "Course", id);
    return course;
  } catch (error) {
    if (isUniqueViolation(error))
      throw uniqueError("name", "courses.field.name", input.name);
    throw error;
  }
}

/** Hard delete, only while no group (archived ones included) uses it. */
export async function deleteCourse(scope: Scope, id: string) {
  const { db } = scope;
  const course = await db.course.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      groups: { orderBy: { name: "asc" }, select: { name: true } },
    },
  });
  if (!course) throw notFound();
  if (course.groups.length > 0) {
    throw blockedError({
      title: msg("common.blocked.deleteTitle", { name: course.name }),
      reason: msg("courses.blocked.inUse", { count: course.groups.length }),
      items: course.groups.map((group) =>
        msg("courses.blocked.groupItem", { name: group.name }),
      ),
    });
  }
  await db.course.delete({ where: { id } });
  await audit(scope, "course.deleted", "Course", id, { name: course.name });
  return course;
}
