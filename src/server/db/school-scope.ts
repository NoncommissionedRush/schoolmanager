import { Prisma, type PrismaClient } from "@/generated/prisma/client";

/**
 * Tenant scoping for Prisma queries. `scopeArgs` rewrites the arguments of a
 * top-level query so it can only read or write rows of one school; the
 * `getSchoolScopedDb()` client (src/server/auth/session.ts) applies it to
 * every query.
 *
 * Nested reads and writes (`include`, nested `create`) are not rewritten:
 * relations between tenant-owned models use composite `[schoolId, id]` keys,
 * so anything reached from a scoped row is already in the same school.
 */

export class CrossSchoolAccessError extends Error {
  constructor(model: string, operation: string, detail: string) {
    super(`Cross-school access blocked: ${model}.${operation} ${detail}`);
    this.name = "CrossSchoolAccessError";
  }
}

type Args = Record<string, unknown> | undefined;
type Where = Record<string, unknown>;

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
    // Only users who belong to the current school are visible.
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
