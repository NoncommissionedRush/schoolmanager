import { Prisma, type PrismaClient } from "@/generated/prisma/client";

/**
 * Tenant scoping for Prisma queries. `scopeArgs` rewrites the arguments of a
 * top-level query so it can only read or write rows of one school; the
 * `getSchoolScopedDb()` client (src/server/auth/session.ts) applies it to
 * every query.
 *
 * Nested reads and writes (`include`, nested `create`) between tenant-owned
 * models are not rewritten: those relations use composite `[schoolId, id]`
 * keys, so anything reached from a scoped row is already in the same school.
 * `User` is the exception — it is not tenant-owned (no `school_id`), so its
 * relations (memberships, profiles, …) are not tied to this school: a user
 * reached through a plain FK (e.g. an audit actor) may belong to another. On the scoped client a `User`, whether
 * queried directly or reached through `include`/`select`, may only return its
 * own scalar fields; relation reads (`include`, relation `select`, `_count`)
 * throw. Load school data from the tenant side instead (e.g.
 * `membership.findMany({ include: { user: true } })`).
 *
 * The same rule applies to filters: every `where` (top-level and nested in
 * `include`/`select`/`_count`) is walked recursively through `AND`/`OR`/`NOT`
 * and relation filters, and wherever it reaches a `User` it may only test
 * the user's scalar fields. Otherwise a filter such as
 * `{ user: { memberships: { some: { schoolId: B } } } }` would answer a
 * yes/no question about another school.
 *
 * `orderBy` follows the same rule, for the same reason: wherever it reaches a
 * `User` it may only sort by the user's scalar fields. Otherwise
 * `{ memberships: { _count: "desc" } }` on User (or `{ user: { … } }` from
 * the tenant side) would rank users by data from other schools.
 */

export class CrossSchoolAccessError extends Error {
  constructor(model: string, operation: string, detail: string) {
    super(`Cross-school access blocked: ${model}.${operation} ${detail}`);
    this.name = "CrossSchoolAccessError";
  }
}

type Args = Record<string, unknown> | undefined;
type Where = Record<string, unknown>;

/**
 * Relation fields, on any model, whose target is `User`. Field names are
 * unique to User relations across the schema (checked in
 * school-scope.test.ts against prisma/schema.prisma).
 */
export const USER_RELATION_FIELDS: ReadonlySet<string> = new Set([
  "user",
  "reportedBy",
  "reviewedBy",
  "actor",
  "createdBy",
  "startedBy",
]);

const USER_SCALARS: ReadonlySet<string> = new Set(
  Object.keys(Prisma.UserScalarFieldEnum),
);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const LOGICAL_OPERATORS: ReadonlySet<string> = new Set(["AND", "OR", "NOT"]);

/** Wrappers of a relation filter: `{ some: {…} }`, `{ is: {…} }`, … */
const RELATION_FILTERS: ReadonlySet<string> = new Set([
  "some",
  "every",
  "none",
  "is",
  "isNot",
]);

const asList = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [value];

/**
 * Throws if a `where` filter reaches into a `User` (the query root when
 * `isUser`, or any User relation further down) and tests anything but the
 * user's own scalar fields. Recurses through `AND`/`OR`/`NOT`, relation
 * filters (`some`/`every`/`none`/`is`/`isNot`) and nested relations.
 */
function assertSafeWhere(
  where: unknown,
  isUser: boolean,
  model: string,
  operation: string,
  path: string,
) {
  for (const node of asList(where)) {
    if (!isObject(node)) continue;
    for (const [key, value] of Object.entries(node)) {
      const keyPath = `${path}.${key}`;
      if (LOGICAL_OPERATORS.has(key)) {
        assertSafeWhere(value, isUser, model, operation, keyPath);
      } else if (isUser) {
        if (!USER_SCALARS.has(key)) {
          throw new CrossSchoolAccessError(
            model,
            operation,
            `(${keyPath}: relation filters on User are not allowed)`,
          );
        }
        // Scalar filters (`{ contains: … }`, `{ not: … }`) can't leave User.
      } else if (USER_RELATION_FIELDS.has(key)) {
        assertSafeRelationFilter(value, true, model, operation, keyPath);
      } else if (isObject(value)) {
        // Another relation (or a scalar filter, which has no relation keys).
        assertSafeRelationFilter(value, false, model, operation, keyPath);
      }
    }
  }
}

/** A relation's filter: either wrapped (`{ some: {…} }`) or a bare `where`. */
function assertSafeRelationFilter(
  filter: unknown,
  isUser: boolean,
  model: string,
  operation: string,
  path: string,
) {
  if (!isObject(filter)) return;
  const wrapped = Object.keys(filter).filter((key) =>
    RELATION_FILTERS.has(key),
  );
  if (wrapped.length > 0) {
    for (const key of wrapped) {
      assertSafeWhere(filter[key], isUser, model, operation, `${path}.${key}`);
    }
    const rest = Object.fromEntries(
      Object.entries(filter).filter(([key]) => !RELATION_FILTERS.has(key)),
    );
    assertSafeWhere(rest, isUser, model, operation, path);
  } else {
    assertSafeWhere(filter, isUser, model, operation, path);
  }
}

/** groupBy's aggregate orderings: `{ _count: { field: "asc" } }`, … */
const AGGREGATE_ORDERINGS: ReadonlySet<string> = new Set([
  "_count",
  "_avg",
  "_sum",
  "_min",
  "_max",
]);

/**
 * Throws if an `orderBy` reaches into a `User` (the query root when
 * `isUser`, or any User relation further down) and sorts by anything but the
 * user's own scalar fields. Accepts a single ordering or a list; recurses
 * through relation orderings (`{ group: { name: "asc" } }`).
 */
function assertSafeOrderBy(
  orderBy: unknown,
  isUser: boolean,
  model: string,
  operation: string,
  path: string,
) {
  for (const node of asList(orderBy)) {
    if (!isObject(node)) continue;
    for (const [key, value] of Object.entries(node)) {
      const keyPath = `${path}.${key}`;
      if (isUser) {
        // `{ email: "asc" }`, `{ email: { sort, nulls } }`, `_relevance`
        // (whose `fields` must be scalars), and groupBy's aggregates.
        if (USER_SCALARS.has(key) || key === "_relevance") continue;
        if (
          AGGREGATE_ORDERINGS.has(key) &&
          isObject(value) &&
          Object.keys(value).every((field) => USER_SCALARS.has(field))
        ) {
          continue;
        }
        throw new CrossSchoolAccessError(
          model,
          operation,
          `(${keyPath}: ordering by User relations is not allowed)`,
        );
      }
      if (USER_RELATION_FIELDS.has(key)) {
        assertSafeOrderBy(value, true, model, operation, keyPath);
      } else if (isObject(value)) {
        // Another relation, `{ sort, nulls }` or an aggregate: none of them
        // has a User relation key unless it reaches one.
        assertSafeOrderBy(value, false, model, operation, keyPath);
      }
    }
  }
}

/**
 * Throws if a `User` node — the query root when `isUser`, or any nested
 * `User` relation — reads a relation, or if any `where` or `orderBy` along
 * the way filters or sorts through a User's relations. Walks `include`, `select` and
 * `_count` trees.
 */
function assertNoUserRelationReads(
  node: unknown,
  isUser: boolean,
  model: string,
  operation: string,
  path: string,
) {
  if (!isObject(node)) return;
  if ("where" in node) {
    assertSafeWhere(node.where, isUser, model, operation, `${path}.where`);
  }
  if ("orderBy" in node) {
    assertSafeOrderBy(
      node.orderBy,
      isUser,
      model,
      operation,
      `${path}.orderBy`,
    );
  }
  for (const key of ["include", "select"] as const) {
    const fields = node[key];
    if (!isObject(fields)) continue;
    for (const [field, value] of Object.entries(fields)) {
      if (!value) continue;
      const fieldPath = `${path}.${key}.${field}`;
      if (isUser && !USER_SCALARS.has(field)) {
        throw new CrossSchoolAccessError(
          model,
          operation,
          `(${fieldPath}: User relations span schools; read them from the tenant side)`,
        );
      }
      if (field === "_count") {
        // `_count: { select: { relation: { where } } }` filters relations.
        assertNoUserRelationReads(value, false, model, operation, fieldPath);
        continue;
      }
      assertNoUserRelationReads(
        value,
        USER_RELATION_FIELDS.has(field),
        model,
        operation,
        fieldPath,
      );
    }
  }
}

/** Models with a `schoolId` column, derived from the generated client. */
export const TENANT_MODELS: ReadonlySet<string> = new Set(
  Object.values(Prisma.ModelName).filter((model) => {
    const fields = (Prisma as unknown as Record<string, unknown>)[
      `${model}ScalarFieldEnum`
    ] as Record<string, string> | undefined;
    return fields !== undefined && "schoolId" in fields;
  }),
);

const READ_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);
const WHERE_WRITE_OPERATIONS = new Set([
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
]);
const CREATE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
]);

function assertSameSchool(
  value: unknown,
  schoolId: string,
  model: string,
  operation: string,
  where: string,
) {
  if (value !== undefined && value !== schoolId) {
    throw new CrossSchoolAccessError(
      model,
      operation,
      `(${where} must be the current school)`,
    );
  }
}

function scopeWhere(
  where: Where | undefined,
  schoolId: string,
  model: string,
  operation: string,
): Where {
  const scoped: Where = { ...where };
  for (const [key, value] of Object.entries(scoped)) {
    // Composite unique inputs, e.g. `schoolId_userId: { schoolId, userId }`.
    if (key.startsWith("schoolId_") && value && typeof value === "object") {
      assertSameSchool(
        (value as Where).schoolId,
        schoolId,
        model,
        operation,
        `where.${key}.schoolId`,
      );
    }
  }
  assertSameSchool(
    scoped.schoolId,
    schoolId,
    model,
    operation,
    "where.schoolId",
  );
  scoped.schoolId = schoolId;
  return scoped;
}

function scopeData(
  data: unknown,
  schoolId: string,
  model: string,
  operation: string,
  { setSchool }: { setSchool: boolean },
): unknown {
  if (Array.isArray(data)) {
    return data.map((row) =>
      scopeData(row, schoolId, model, operation, { setSchool }),
    );
  }
  const row = { ...(data as Where) };
  if ("school" in row) {
    throw new CrossSchoolAccessError(
      model,
      operation,
      "(set schoolId implicitly; `school` relation writes are not allowed)",
    );
  }
  assertSameSchool(row.schoolId, schoolId, model, operation, "data.schoolId");
  if (setSchool) row.schoolId = schoolId;
  return row;
}

function scopeTenant(
  model: string,
  operation: string,
  args: Args,
  schoolId: string,
): Args {
  const a: Record<string, unknown> = { ...args };
  if (READ_OPERATIONS.has(operation) || WHERE_WRITE_OPERATIONS.has(operation)) {
    a.where = scopeWhere(a.where as Where, schoolId, model, operation);
    if ("data" in a) {
      a.data = scopeData(a.data, schoolId, model, operation, {
        setSchool: false,
      });
    }
    return a;
  }
  if (CREATE_OPERATIONS.has(operation)) {
    a.data = scopeData(a.data, schoolId, model, operation, { setSchool: true });
    return a;
  }
  if (operation === "upsert") {
    a.where = scopeWhere(a.where as Where, schoolId, model, operation);
    a.create = scopeData(a.create, schoolId, model, operation, {
      setSchool: true,
    });
    a.update = scopeData(a.update, schoolId, model, operation, {
      setSchool: false,
    });
    return a;
  }
  throw new CrossSchoolAccessError(model, operation, "(unsupported operation)");
}

function withExtraCondition(where: Where | undefined, condition: Where): Where {
  const and = where?.AND;
  return {
    ...where,
    AND: [...(Array.isArray(and) ? and : and ? [and] : []), condition],
  };
}

function scopeGlobal(
  model: string,
  operation: string,
  args: Args,
  schoolId: string,
): Args {
  const a: Record<string, unknown> = { ...args };
  if (
    model === "School" &&
    (READ_OPERATIONS.has(operation) || operation === "update")
  ) {
    const where = (a.where ?? {}) as Where;
    assertSameSchool(where.id, schoolId, model, operation, "where.id");
    a.where = { ...where, id: schoolId };
    return a;
  }
  if (model === "User" && READ_OPERATIONS.has(operation)) {
    // `where` was checked by `assertNoUserRelationReads`. Only users who belong to the current school are visible.
    a.where = withExtraCondition(a.where as Where, {
      memberships: { some: { schoolId } },
    });
    return a;
  }
  throw new CrossSchoolAccessError(
    model,
    operation,
    "(not allowed on the school-scoped client; use the global client in auth/admin code)",
  );
}

/** Rewrites one top-level query's arguments so it stays inside `schoolId`. */
export function scopeArgs(
  model: string,
  operation: string,
  args: Args,
  schoolId: string,
): Args {
  assertNoUserRelationReads(args, model === "User", model, operation, "args");
  return TENANT_MODELS.has(model)
    ? scopeTenant(model, operation, args, schoolId)
    : scopeGlobal(model, operation, args, schoolId);
}

/** Wraps a Prisma client so every query is scoped to `schoolId`. */
export function scopeToSchool(client: PrismaClient, schoolId: string) {
  return client.$extends({
    name: "school-scope",
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return query(
            scopeArgs(model, operation, args as Args, schoolId) as typeof args,
          );
        },
      },
    },
  });
}
