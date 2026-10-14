// Generator service: readiness, drafts, runs and apply
// (docs/architecture/generator.md §4.6, §5, §7). It loads a snapshot through
// the school-scoped client, asks the pure engine
// (src/server/scheduling/generator) for teachers, and applies a draft
// through the same checks and lesson sync as the editor, in one transaction
// per action. Callers check `requireRole("ADMIN")` first and pass
// `getSchoolScopedDb()`.

import { createHash } from "node:crypto";
import { setImmediate as nextTick } from "node:timers/promises";

import { Prisma } from "@/generated/prisma/client";
import { ACTIVE_REPLACEMENT } from "@/server/replacements/release";
import {
  addDays,
  buildCalendar,
  checkLesson,
  checkTimetable,
  type Conflict,
  fromIsoDate,
  type IsoDate,
  isoWeekday,
  type LessonInfo,
  planGroupTeacherChange,
  type SlotInfo,
  toIsoDate,
} from "@/server/scheduling";
import {
  assignTeachersSteps,
  checkGeneratorReadiness,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TIME_LIMIT_MS,
  type DraftAssignmentInput,
  type DraftMode,
  draftTeacherOptions,
  evaluateDraft,
  fingerprintPayload,
  type GeneratorInput,
  type GeneratorResult,
  type GroupReadiness,
  type Readiness,
  type TeacherOption,
  timeAsSlot,
} from "@/server/scheduling/generator";

import {
  type Actor,
  audit,
  inTransaction,
  type LessonChanges,
  load,
  loadExistingLessons,
  type Loaded,
  publishTermIn,
  SchedulingError,
  type SchoolDb,
  syncSlots,
  type Tx,
} from "./service";

export type GeneratorErrorCode =
  | "RUN_IN_PROGRESS"
  | "RUN_INTERRUPTED"
  | "DRAFT_CHANGED"
  | "EFFECTIVE_DATE_PASSED"
  | "EFFECTIVE_DATE_OUTSIDE_TERM"
  | "TERM_PUBLISHED"
  | "TERM_NOT_PUBLISHED"
  | "TEACHER_ARCHIVED"
  | "NOTHING_TO_ASSIGN"
  | "GROUP_NOT_IN_DRAFT";

/** A request the generator refuses; `code` maps to `scheduling.generator.errors.<code>`. */
export class GeneratorError extends Error {
  constructor(
    readonly code: GeneratorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GeneratorError";
  }
}

/** A run whose heartbeat is older than this died with its process (§4.6). */
export const STALE_RUN_MS = 30_000;
/** Progress is written at most this often (§4.6). */
const PROGRESS_EVERY_MS = 500;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** The next Monday on or after tomorrow: the default effective date (§5.2). */
export function defaultEffectiveDate(today: IsoDate): IsoDate {
  let date = addDays(today, 1);
  while (isoWeekday(date) !== 1) date = addDays(date, 1);
  return date;
}

type Snapshot = { loaded: Loaded; input: GeneratorInput };

/** Everything a run reads (§4.2 step 1), as the engine's plain input. */
async function loadSnapshot(
  tx: Tx,
  termId: string,
  now: Date,
  mode: DraftMode,
  effectiveFrom: IsoDate | null,
  assignments: DraftAssignmentInput[],
): Promise<Snapshot> {
  const loaded = await load(tx, termId, now);
  const [groups, teachers] = await Promise.all([
    tx.group.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        levelId: true,
        lessonTimes: {
          select: {
            id: true,
            weekday: true,
            startMinute: true,
            endMinute: true,
            roomId: true,
          },
        },
        termSkips: { where: { termId }, select: { id: true } },
      },
    }),
    tx.teacherProfile.findMany({
      select: {
        id: true,
        maxMinutesPerWeek: true,
        user: { select: { name: true, deletedAt: true } },
        levels: { select: { levelId: true } },
      },
    }),
  ]);
  return {
    loaded,
    input: {
      context: loaded.context,
      termId,
      mode,
      effectiveFrom: mode === "REPLACE" ? null : effectiveFrom,
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        levelId: g.levelId,
        lessonTimes: g.lessonTimes,
        skipped: g.termSkips.length > 0,
      })),
      teachers: teachers.map((t) => ({
        id: t.id,
        name: t.user.name,
        levelIds: t.levels.map((l) => l.levelId),
        maxMinutesPerWeek: t.maxMinutesPerWeek,
        archived: t.user.deletedAt !== null,
      })),
      levels: (loaded.context.levels ?? []).map((l) => ({
        id: l.id,
        name: l.name,
      })),
      assignments,
    },
  };
}

export function fingerprint(input: GeneratorInput): string {
  return createHash("sha256").update(fingerprintPayload(input)).digest("hex");
}

type DraftRow = {
  id: string;
  termId: string;
  mode: DraftMode;
  effectiveFrom: Date | null;
  version: number;
};

const effectiveOf = (draft: Pick<DraftRow, "effectiveFrom">) =>
  draft.effectiveFrom ? toIsoDate(draft.effectiveFrom) : null;

async function draftAssignments(
  tx: Tx,
  draftId: string,
): Promise<DraftAssignmentInput[]> {
  return tx.timetableDraftAssignment.findMany({
    where: { draftId },
    select: { groupId: true, teacherId: true, locked: true, origin: true },
    orderBy: { groupId: "asc" },
  });
}

async function findDraft(tx: Tx, draftId: string): Promise<DraftRow> {
  const draft = await tx.timetableDraft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      termId: true,
      mode: true,
      effectiveFrom: true,
      version: true,
    },
  });
  if (!draft) {
    throw new SchedulingError("NOT_FOUND", `Draft ${draftId} not found`);
  }
  return draft;
}

/** Locks the draft row (`FOR UPDATE`) and checks the caller's version. */
async function lockDraft(
  tx: Tx,
  schoolId: string,
  draftId: string,
  version: number | null,
): Promise<DraftRow> {
  await tx.$queryRaw`SELECT id FROM timetable_drafts WHERE id = ${draftId}::uuid AND school_id = ${schoolId}::uuid FOR UPDATE`;
  const draft = await findDraft(tx, draftId);
  if (version !== null && draft.version !== version) {
    throw new GeneratorError(
      "DRAFT_CHANGED",
      `Draft ${draftId} is at version ${draft.version}, not ${version}`,
    );
  }
  return draft;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Marks a running run whose heartbeat stopped as FAILED (§4.6 Crashes). */
async function failIfStale(
  tx: Tx,
  run: { id: string; status: string; heartbeatAt: Date },
  now: Date,
): Promise<boolean> {
  if (
    run.status !== "RUNNING" ||
    now.getTime() - run.heartbeatAt.getTime() <= STALE_RUN_MS
  ) {
    return false;
  }
  const { count } = await tx.generatorRun.updateMany({
    where: { id: run.id, status: "RUNNING" },
    data: { status: "FAILED", errorCode: "RUN_INTERRUPTED", finishedAt: now },
  });
  return count > 0;
}

/** Refuses with RUN_IN_PROGRESS while a live run works on the term. */
async function assertNoRun(tx: Tx, termId: string, now: Date) {
  const running = await tx.generatorRun.findFirst({
    where: { termId, status: "RUNNING" },
    select: { id: true, status: true, heartbeatAt: true },
  });
  if (running && !(await failIfStale(tx, running, now))) {
    throw new GeneratorError(
      "RUN_IN_PROGRESS",
      `Run ${running.id} is assigning teachers`,
    );
  }
}

export type StartRunRequest = {
  termId: string;
  mode: DraftMode;
  /** FILL / REPLAN_FROM: _D_ (default: next Monday on or after tomorrow). */
  effectiveFrom?: IsoDate;
  /** REPLACE with editor slots: import current teachers, locked (default). */
  keepCurrentTeachers?: boolean;
  maxIterations?: number;
  timeLimitMs?: number;
};

/**
 * Creates the draft if needed (mode, _D_, keep or reassign, §5.2) and a
 * RUNNING run. The caller executes it with `executeRun` after the request
 * returns. A draft with the same mode and date is reassigned: its locked
 * assignments stay (§5.4).
 */
export async function startRun(
  db: SchoolDb,
  actor: Actor,
  request: StartRunRequest,
  now = new Date(),
): Promise<{ runId: string; draftId: string }> {
  try {
    return await startRunIn(db, actor, request, now);
  } catch (error) {
    // Two first runs at once: the second draft or run hits a unique key.
    if ((error as { code?: string }).code === "P2002") {
      throw new GeneratorError("RUN_IN_PROGRESS", "A run is in progress");
    }
    throw error;
  }
}

async function startRunIn(
  db: SchoolDb,
  actor: Actor,
  request: StartRunRequest,
  now: Date,
): Promise<{ runId: string; draftId: string }> {
  return db.$transaction(async (tx) => {
    const school = await tx.school.findFirstOrThrow({ select: { id: true } });
    const term = await tx.term.findUnique({ where: { id: request.termId } });
    if (!term) {
      throw new SchedulingError(
        "NOT_FOUND",
        `Term ${request.termId} not found`,
      );
    }
    const published = term.timetablePublishedAt !== null;
    if (request.mode === "REPLACE" && published) {
      throw new GeneratorError("TERM_PUBLISHED", "The term is published");
    }
    if (request.mode !== "REPLACE" && !published) {
      throw new GeneratorError("TERM_NOT_PUBLISHED", "The term is a draft");
    }
    const loaded = await load(tx, request.termId, now);
    let effectiveFrom: IsoDate | null = null;
    if (request.mode !== "REPLACE") {
      effectiveFrom =
        request.effectiveFrom ?? defaultEffectiveDate(loaded.today);
      if (effectiveFrom <= loaded.today) {
        throw new GeneratorError(
          "EFFECTIVE_DATE_PASSED",
          "Changes must start after today",
        );
      }
      if (
        effectiveFrom < loaded.term.startDate ||
        effectiveFrom > loaded.term.endDate
      ) {
        throw new GeneratorError(
          "EFFECTIVE_DATE_OUTSIDE_TERM",
          "The effective date must be inside the term",
        );
      }
    }
    await assertNoRun(tx, request.termId, now);

    let draft = await tx.timetableDraft.findUnique({
      where: {
        schoolId_termId: { schoolId: school.id, termId: request.termId },
      },
    });
    const fresh =
      !draft ||
      draft.mode !== request.mode ||
      effectiveOf(draft) !== effectiveFrom;
    const snapshot = await loadSnapshot(
      tx,
      request.termId,
      now,
      request.mode,
      effectiveFrom,
      fresh || !draft ? [] : await draftAssignments(tx, draft.id),
    );
    const readiness = checkGeneratorReadiness(snapshot.input);
    const included = readiness.groups.filter(isIncluded);
    if (included.length === 0) {
      throw new GeneratorError("NOTHING_TO_ASSIGN", "No group takes part");
    }

    if (fresh) {
      const data = {
        mode: request.mode,
        effectiveFrom: effectiveFrom ? fromIsoDate(effectiveFrom) : null,
        inputFingerprint: null,
        generatedAt: null,
        summary: Prisma.DbNull,
        unassigned: [],
        warnings: [],
        runStats: Prisma.DbNull,
        createdById: actor.userId,
      };
      if (draft) {
        await tx.timetableDraftAssignment.deleteMany({
          where: { draftId: draft.id },
        });
        draft = await tx.timetableDraft.update({
          where: { id: draft.id },
          data: { ...data, version: { increment: 1 } },
        });
      } else {
        draft = await tx.timetableDraft.create({
          data: { ...data, schoolId: school.id, termId: request.termId },
        });
      }
      // "Keep current teachers": the editor's teachers, locked (§5.2).
      if (request.mode === "REPLACE" && request.keepCurrentTeachers !== false) {
        const imported = included.filter((g) => g.currentTeacherId !== null);
        if (imported.length > 0) {
          await tx.timetableDraftAssignment.createMany({
            data: imported.map((g) => ({
              schoolId: school.id,
              draftId: draft!.id,
              groupId: g.groupId,
              teacherId: g.currentTeacherId,
              locked: true,
              origin: "IMPORTED" as const,
            })),
          });
        }
      }
    }

    const maxIterations = request.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const timeLimitMs = request.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;
    const run = await tx.generatorRun.create({
      data: {
        schoolId: school.id,
        termId: request.termId,
        draftId: draft!.id,
        maxIterations,
        timeLimitMs,
        startedById: actor.userId,
        heartbeatAt: now,
        startedAt: now,
        // The draft as the run found it: saving requires it unchanged.
        progress: {
          phase: "checking",
          assigned: 0,
          total: included.length,
          draftVersion: draft!.version,
        },
      },
      select: { id: true },
    });
    await audit(
      tx,
      school.id,
      actor,
      "generator_run.started",
      "GeneratorRun",
      run.id,
      {
        termId: request.termId,
        mode: request.mode,
        effectiveFrom,
        fresh,
        groups: included.length,
        maxIterations,
        timeLimitMs,
      },
    );
    return { runId: run.id, draftId: draft!.id };
  });
}

const isIncluded = (g: GroupReadiness) =>
  g.status === "READY" || g.status === "LEVEL_UNCOVERED";

export type ExecuteOptions = {
  /** Wall clock for heartbeats (tests pass a fixed one). */
  now?: () => Date;
  /** Monotonic milliseconds for the engine's time cap. */
  clock?: () => number;
};

/**
 * Executes a RUNNING run (§4.6): reads a snapshot without the timetable
 * lock, drives the engine step by step (yielding to other requests), writes
 * progress and the heartbeat, honours cancellation, and saves the draft if
 * nobody changed it meanwhile (`DRAFT_CHANGED` otherwise, §5.7).
 */
export async function executeRun(
  db: SchoolDb,
  runId: string,
  options: ExecuteOptions = {},
): Promise<"DONE" | "CANCELLED" | "FAILED"> {
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? (() => performance.now());
  const run = await db.generatorRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== "RUNNING") return "FAILED";
  const startedAt = clock();
  // Run entries name the admin who started it (null once deleted).
  const auditRun = (tx: Tx, action: string, data: Record<string, unknown>) =>
    tx.auditLog.create({
      data: {
        schoolId: run.schoolId,
        actorId: run.startedById,
        action,
        entityType: "GeneratorRun",
        entityId: runId,
        data: json(data),
      },
    });

  const finishAs = async (
    status: "CANCELLED" | "FAILED",
    errorCode: string | null,
  ) => {
    await db.$transaction(async (tx) => {
      const { count } = await tx.generatorRun.updateMany({
        where: { id: runId, status: "RUNNING" },
        data: { status, errorCode, finishedAt: now() },
      });
      if (count > 0) {
        await auditRun(
          tx,
          status === "CANCELLED"
            ? "generator_run.cancelled"
            : "generator_run.failed",
          { errorCode },
        );
      }
    });
    return status;
  };

  try {
    const { draft, snapshot } = await db.$transaction(async (tx) => {
      const draft = await findDraft(tx, run.draftId);
      const snapshot = await loadSnapshot(
        tx,
        draft.termId,
        now(),
        draft.mode,
        effectiveOf(draft),
        await draftAssignments(tx, draft.id),
      );
      return { draft, snapshot };
    });
    const input = {
      ...snapshot.input,
      maxIterations: run.maxIterations,
      timeLimitMs: run.timeLimitMs,
    };
    const baseVersion =
      (run.progress as { draftVersion?: number } | null)?.draftVersion ??
      draft.version;

    const steps = assignTeachersSteps(input, { clock });
    let lastWrite = -Infinity;
    let next = steps.next();
    while (!next.done) {
      if (clock() - lastWrite >= PROGRESS_EVERY_MS) {
        lastWrite = clock();
        const row = await db.generatorRun.update({
          where: { id: runId },
          data: {
            heartbeatAt: now(),
            progress: {
              phase: next.value.phase,
              assigned: next.value.assigned,
              total: next.value.total,
              elapsedMs: Math.round(clock() - startedAt),
              draftVersion: baseVersion,
            },
          },
          select: { cancelRequested: true, status: true },
        });
        if (row.status !== "RUNNING") return "FAILED";
        if (row.cancelRequested) return finishAs("CANCELLED", null);
      }
      await nextTick();
      next = steps.next();
    }
    const result = next.value;
    const durationMs = Math.round(clock() - startedAt);

    return await db.$transaction(async (tx) => {
      // Lock the run row so a cancel or a stale-run FAILED can't race the
      // save: they wait for this transaction, or it sees them.
      await tx.$queryRaw`SELECT id FROM generator_runs WHERE id = ${runId}::uuid AND school_id = ${run.schoolId}::uuid FOR UPDATE`;
      const current = await tx.generatorRun.findUnique({
        where: { id: runId },
        select: { status: true, cancelRequested: true },
      });
      if (current?.status !== "RUNNING") return "FAILED" as const;
      if (current.cancelRequested) {
        await tx.generatorRun.update({
          where: { id: runId },
          data: { status: "CANCELLED", finishedAt: now() },
        });
        await auditRun(tx, "generator_run.cancelled", {});
        return "CANCELLED" as const;
      }
      const locked = await lockDraft(tx, run.schoolId, draft.id, null);
      if (locked.version !== baseVersion) {
        await tx.generatorRun.update({
          where: { id: runId },
          data: {
            status: "FAILED",
            errorCode: "DRAFT_CHANGED",
            finishedAt: now(),
          },
        });
        await auditRun(tx, "generator_run.failed", {
          errorCode: "DRAFT_CHANGED",
        });
        return "FAILED" as const;
      }
      const previous = await tx.timetableDraft.findUnique({
        where: { id: draft.id },
        select: { summary: true },
      });
      const stats = {
        iterations: result.iterations,
        durationMs,
        stoppedBy: result.stoppedBy,
        maxIterations: run.maxIterations,
        timeLimitMs: run.timeLimitMs,
      };
      await saveResult(tx, run.schoolId, draft.id, result, {
        fingerprint: fingerprint(input),
        generatedAt: now(),
        runStats: stats,
        previousRange: previousRange(previous?.summary),
        replaceAssignments: true,
      });
      const summary = runSummary(result, stats);
      await tx.generatorRun.update({
        where: { id: runId },
        data: {
          status: "DONE",
          finishedAt: now(),
          heartbeatAt: now(),
          result: summary,
          progress: {
            phase: "balancing",
            assigned: summary.assigned,
            total: summary.assigned + summary.unassigned,
            elapsedMs: durationMs,
          },
        },
      });
      await auditRun(tx, "generator_run.finished", summary);
      return "DONE" as const;
    });
  } catch (error) {
    if (error instanceof GeneratorError || error instanceof SchedulingError) {
      return finishAs("FAILED", error.code);
    }
    await finishAs("FAILED", "INTERNAL_ERROR");
    throw error;
  }
}

function runSummary(
  result: GeneratorResult,
  stats: { iterations: number; durationMs: number; stoppedBy: string },
) {
  const unassigned = result.final.unassignedGroups;
  return {
    ...stats,
    assigned: result.assignments.length - unassigned,
    unassigned,
    workloadRange: {
      minMinutes: result.final.minMinutes,
      maxMinutes: result.final.maxMinutes,
    },
  };
}

function previousRange(summary: unknown) {
  const final = (
    summary as { final?: { minMinutes: number; maxMinutes: number } } | null
  )?.final;
  return final
    ? { minMinutes: final.minMinutes, maxMinutes: final.maxMinutes }
    : null;
}

const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** Stores a run's or a check's result on the draft (§5.1, §3.3). */
async function saveResult(
  tx: Tx,
  schoolId: string,
  draftId: string,
  result: GeneratorResult,
  options: {
    fingerprint?: string;
    generatedAt?: Date;
    runStats?: unknown;
    previousRange?: unknown;
    replaceAssignments: boolean;
  },
) {
  if (options.replaceAssignments) {
    await tx.timetableDraftAssignment.deleteMany({ where: { draftId } });
    if (result.assignments.length > 0) {
      await tx.timetableDraftAssignment.createMany({
        data: result.assignments.map((a) => ({
          schoolId,
          draftId,
          groupId: a.groupId,
          teacherId: a.teacherId,
          locked: a.locked,
          origin: a.origin,
        })),
      });
    }
  }
  await tx.timetableDraft.update({
    where: { id: draftId },
    data: {
      ...(options.replaceAssignments && { version: { increment: 1 } }),
      ...(options.fingerprint && { inputFingerprint: options.fingerprint }),
      ...(options.generatedAt && { generatedAt: options.generatedAt }),
      ...(options.runStats !== undefined && {
        runStats: json(options.runStats),
      }),
      summary: json({
        construction: result.construction,
        final: result.final,
        ...(options.previousRange !== undefined && {
          previousRange: options.previousRange,
        }),
      }),
      unassigned: json(result.unassigned),
      warnings: json({
        groups: result.warnings,
        teachers: result.teacherWarnings,
        removedAssignments: result.removedAssignments,
        fallback: result.assignments
          .filter((a) => a.fallback)
          .map((a) => a.groupId),
      }),
    },
  });
}

export type RunView = {
  id: string;
  termId: string;
  draftId: string;
  status: "RUNNING" | "DONE" | "CANCELLED" | "FAILED";
  cancelRequested: boolean;
  progress: unknown;
  result: unknown;
  errorCode: string | null;
  startedById: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

const runSelect = {
  id: true,
  termId: true,
  draftId: true,
  status: true,
  cancelRequested: true,
  progress: true,
  result: true,
  errorCode: true,
  startedById: true,
  startedAt: true,
  finishedAt: true,
  heartbeatAt: true,
} as const;

/** A run's progress or result; a run with a stale heartbeat is marked FAILED. */
export async function getRun(
  db: SchoolDb,
  runId: string,
  now = new Date(),
): Promise<RunView> {
  return db.$transaction(async (tx) => {
    const run = await tx.generatorRun.findUnique({
      where: { id: runId },
      select: runSelect,
    });
    if (!run) throw new SchedulingError("NOT_FOUND", `Run ${runId} not found`);
    if (await failIfStale(tx, run, now)) {
      return {
        ...viewOf(run),
        status: "FAILED",
        errorCode: "RUN_INTERRUPTED",
        finishedAt: now,
      };
    }
    return viewOf(run);
  });
}

function viewOf(run: RunView & { heartbeatAt: Date }): RunView {
  const view: RunView & { heartbeatAt?: Date } = { ...run };
  delete view.heartbeatAt;
  return view;
}

/** Asks a running run to stop; it saves nothing (§4.6 Cancel). */
export async function cancelRun(db: SchoolDb, runId: string): Promise<void> {
  const run = await db.generatorRun.findUnique({
    where: { id: runId },
    select: { id: true },
  });
  if (!run) throw new SchedulingError("NOT_FOUND", `Run ${runId} not found`);
  await db.generatorRun.updateMany({
    where: { id: runId, status: "RUNNING" },
    data: { cancelRequested: true },
  });
}

// ---------------------------------------------------------------------------
// Readiness and skip flags
// ---------------------------------------------------------------------------

/**
 * The Groups tab (§2.5): every group's readiness and the readiness checks,
 * without a run. Mode and date default to the term's draft, else to the
 * term's state (REPLACE, or FILL from the next Monday).
 */
export async function checkReadiness(
  db: SchoolDb,
  termId: string,
  options: { mode?: DraftMode; effectiveFrom?: IsoDate } = {},
  now = new Date(),
): Promise<Readiness> {
  return db.$transaction(async (tx) => {
    const term = await tx.term.findUnique({ where: { id: termId } });
    if (!term)
      throw new SchedulingError("NOT_FOUND", `Term ${termId} not found`);
    const draft = await tx.timetableDraft.findFirst({ where: { termId } });
    const published = term.timetablePublishedAt !== null;
    const mode =
      options.mode ?? draft?.mode ?? (published ? "FILL" : "REPLACE");
    const loaded = await load(tx, termId, now);
    const effectiveFrom =
      mode === "REPLACE"
        ? null
        : (options.effectiveFrom ??
          (draft ? effectiveOf(draft) : null) ??
          defaultEffectiveDate(loaded.today));
    const { input } = await loadSnapshot(
      tx,
      termId,
      now,
      mode,
      effectiveFrom,
      [],
    );
    return checkGeneratorReadiness(input);
  });
}

/** "Skip this term" / "Include" (§2.5). Idempotent. */
export async function setGroupSkipped(
  db: SchoolDb,
  actor: Actor,
  request: { termId: string; groupId: string; skipped: boolean },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const school = await tx.school.findFirstOrThrow({ select: { id: true } });
    const [term, group] = await Promise.all([
      tx.term.findUnique({
        where: { id: request.termId },
        select: { id: true },
      }),
      tx.group.findUnique({
        where: { id: request.groupId },
        select: { id: true },
      }),
    ]);
    if (!term || !group) {
      throw new SchedulingError("NOT_FOUND", "Term or group not found");
    }
    const existing = await tx.groupTermSkip.findUnique({
      where: {
        schoolId_groupId_termId: {
          schoolId: school.id,
          groupId: request.groupId,
          termId: request.termId,
        },
      },
    });
    if (request.skipped && !existing) {
      const created = await tx.groupTermSkip.create({
        data: {
          schoolId: school.id,
          groupId: request.groupId,
          termId: request.termId,
          createdById: actor.userId,
        },
      });
      await audit(
        tx,
        school.id,
        actor,
        "group_term_skip.created",
        "GroupTermSkip",
        created.id,
        request,
      );
    } else if (!request.skipped && existing) {
      await tx.groupTermSkip.delete({ where: { id: existing.id } });
      await audit(
        tx,
        school.id,
        actor,
        "group_term_skip.deleted",
        "GroupTermSkip",
        existing.id,
        request,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export type DraftView = {
  id: string;
  termId: string;
  mode: DraftMode;
  effectiveFrom: IsoDate | null;
  version: number;
  generatedAt: Date | null;
  /** The data changed since the last run (§5.5). */
  outOfDate: boolean;
  assignments: DraftAssignmentInput[];
  summary: unknown;
  unassigned: unknown;
  warnings: unknown;
  runStats: unknown;
  latestRun: RunView | null;
};

async function draftView(
  tx: Tx,
  draftId: string,
  now: Date,
): Promise<DraftView> {
  const draft = await tx.timetableDraft.findUnique({ where: { id: draftId } });
  if (!draft)
    throw new SchedulingError("NOT_FOUND", `Draft ${draftId} not found`);
  const assignments = await draftAssignments(tx, draftId);
  const { input } = await loadSnapshot(
    tx,
    draft.termId,
    now,
    draft.mode,
    effectiveOf(draft),
    assignments,
  );
  const latest = await tx.generatorRun.findFirst({
    where: { draftId },
    orderBy: { startedAt: "desc" },
    select: runSelect,
  });
  let latestRun = latest ? viewOf(latest) : null;
  if (latest && (await failIfStale(tx, latest, now))) {
    latestRun = {
      ...latestRun!,
      status: "FAILED",
      errorCode: "RUN_INTERRUPTED",
    };
  }
  return {
    id: draft.id,
    termId: draft.termId,
    mode: draft.mode,
    effectiveFrom: effectiveOf(draft),
    version: draft.version,
    generatedAt: draft.generatedAt,
    outOfDate:
      draft.inputFingerprint !== null &&
      draft.inputFingerprint !== fingerprint(input),
    assignments,
    summary: draft.summary,
    unassigned: draft.unassigned,
    warnings: draft.warnings,
    runStats: draft.runStats,
    latestRun,
  };
}

/** The term's draft for review (§7 `getDraft`); null when there is none. */
export async function getDraft(
  db: SchoolDb,
  termId: string,
  now = new Date(),
): Promise<DraftView | null> {
  return db.$transaction(async (tx) => {
    const draft = await tx.timetableDraft.findFirst({
      where: { termId },
      select: { id: true },
    });
    return draft ? draftView(tx, draft.id, now) : null;
  });
}

/** The teacher picker for one group of the draft (§5.3). */
export async function teacherOptions(
  db: SchoolDb,
  request: { draftId: string; groupId: string },
  now = new Date(),
): Promise<TeacherOption[]> {
  return db.$transaction(async (tx) => {
    const draft = await findDraft(tx, request.draftId);
    const { input } = await loadSnapshot(
      tx,
      draft.termId,
      now,
      draft.mode,
      effectiveOf(draft),
      await draftAssignments(tx, draft.id),
    );
    const options = draftTeacherOptions(input, request.groupId);
    if (!options) {
      throw new GeneratorError(
        "GROUP_NOT_IN_DRAFT",
        "The group is not in the draft",
      );
    }
    return options;
  });
}

export type DraftEditResult =
  | { ok: true; draft: DraftView }
  | {
      ok: false;
      reason: "BLOCKING_CONFLICTS";
      option: TeacherOption;
    }
  | { ok: false; reason: "DRAFT_CHANGED"; draft: DraftView };

/** Runs a draft edit under the row lock; DRAFT_CHANGED carries the fresh draft. */
async function editDraft(
  db: SchoolDb,
  request: { draftId: string; version: number },
  now: Date,
  edit: (
    tx: Tx,
    draft: DraftRow,
  ) => Promise<Extract<
    DraftEditResult,
    { reason: "BLOCKING_CONFLICTS" }
  > | null>,
): Promise<DraftEditResult> {
  try {
    return await db.$transaction(async (tx) => {
      const school = await tx.school.findFirstOrThrow({ select: { id: true } });
      const draft = await lockDraft(
        tx,
        school.id,
        request.draftId,
        request.version,
      );
      await assertNoRun(tx, draft.termId, now);
      const refused = await edit(tx, draft);
      if (refused) return refused;
      // Re-check so the review shows the edit's consequences (§5.3).
      const assignments = await draftAssignments(tx, draft.id);
      const { input } = await loadSnapshot(
        tx,
        draft.termId,
        now,
        draft.mode,
        effectiveOf(draft),
        assignments,
      );
      await saveResult(tx, school.id, draft.id, evaluateDraft(input), {
        replaceAssignments: false,
      });
      await tx.timetableDraft.update({
        where: { id: draft.id },
        data: { version: { increment: 1 } },
      });
      return { ok: true as const, draft: await draftView(tx, draft.id, now) };
    });
  } catch (error) {
    if (error instanceof GeneratorError && error.code === "DRAFT_CHANGED") {
      const draft = await db.$transaction((tx) =>
        draftView(tx, request.draftId, now),
      );
      return { ok: false, reason: "DRAFT_CHANGED", draft };
    }
    throw error;
  }
}

/**
 * Sets a group's teacher (or none) by hand: locked, `MANUAL` (§5.3). Busy
 * teachers are refused (`BLOCKING_CONFLICTS`); unavailable, other-level and
 * over-max picks are allowed and acknowledged on apply. Not audited: nothing
 * live changes; the applied entry records the result (§7).
 */
export async function saveAssignment(
  db: SchoolDb,
  request: {
    draftId: string;
    version: number;
    groupId: string;
    teacherId: string | null;
  },
  now = new Date(),
): Promise<DraftEditResult> {
  return editDraft(db, request, now, async (tx, draft) => {
    const row = await tx.timetableDraftAssignment.findUnique({
      where: {
        draftId_groupId: { draftId: draft.id, groupId: request.groupId },
      },
    });
    if (!row) {
      throw new GeneratorError(
        "GROUP_NOT_IN_DRAFT",
        "The group is not in the draft",
      );
    }
    if (request.teacherId !== null) {
      const teacher = await tx.teacherProfile.findUnique({
        where: { id: request.teacherId },
        select: { user: { select: { deletedAt: true } } },
      });
      if (!teacher) {
        throw new SchedulingError(
          "NOT_FOUND",
          `Teacher ${request.teacherId} not found`,
        );
      }
      if (teacher.user.deletedAt) {
        throw new GeneratorError("TEACHER_ARCHIVED", "The teacher is archived");
      }
      const { input } = await loadSnapshot(
        tx,
        draft.termId,
        now,
        draft.mode,
        effectiveOf(draft),
        await draftAssignments(tx, draft.id),
      );
      const option = draftTeacherOptions(input, request.groupId)?.find(
        (o) => o.teacherId === request.teacherId,
      );
      if (option?.section === "BUSY") {
        return {
          ok: false as const,
          reason: "BLOCKING_CONFLICTS" as const,
          option,
        };
      }
    }
    await tx.timetableDraftAssignment.update({
      where: { id: row.id },
      data: { teacherId: request.teacherId, locked: true, origin: "MANUAL" },
    });
    return null;
  });
}

/** Locks or unlocks several assignments, e.g. "Lock all of {teacher}" (§5.3). */
export async function setAssignmentsLocked(
  db: SchoolDb,
  request: {
    draftId: string;
    version: number;
    groupIds: string[];
    locked: boolean;
  },
  now = new Date(),
): Promise<DraftEditResult> {
  return editDraft(db, request, now, async (tx, draft) => {
    await tx.timetableDraftAssignment.updateMany({
      where: { draftId: draft.id, groupId: { in: request.groupIds } },
      data: { locked: request.locked },
    });
    return null;
  });
}

/**
 * Check draft (§5.3): conflicts, warnings and reasons recomputed against
 * current data; no assignment changes.
 */
export async function checkDraft(
  db: SchoolDb,
  request: { draftId: string },
  now = new Date(),
): Promise<DraftView> {
  return db.$transaction(async (tx) => {
    // Under the draft lock, so a concurrent edit can't be overwritten with
    // results for its old assignments.
    const school = await tx.school.findFirstOrThrow({ select: { id: true } });
    const draft = await lockDraft(tx, school.id, request.draftId, null);
    await assertNoRun(tx, draft.termId, now);
    const { input } = await loadSnapshot(
      tx,
      draft.termId,
      now,
      draft.mode,
      effectiveOf(draft),
      await draftAssignments(tx, draft.id),
    );
    await saveResult(tx, school.id, draft.id, evaluateDraft(input), {
      replaceAssignments: false,
    });
    return draftView(tx, draft.id, now);
  });
}

/** Deletes the draft and its assignments (§5.8). */
export async function discardDraft(
  db: SchoolDb,
  actor: Actor,
  draftId: string,
  now = new Date(),
): Promise<void> {
  await db.$transaction(async (tx) => {
    const school = await tx.school.findFirstOrThrow({ select: { id: true } });
    const draft = await lockDraft(tx, school.id, draftId, null);
    await assertNoRun(tx, draft.termId, now);
    await tx.timetableDraft.delete({ where: { id: draftId } });
    await audit(
      tx,
      school.id,
      actor,
      "timetable_draft.discarded",
      "TimetableDraft",
      draftId,
      { termId: draft.termId, mode: draft.mode },
    );
  });
}

// ---------------------------------------------------------------------------
// Apply and preview (§5.6)
// ---------------------------------------------------------------------------

/** Something the admin must acknowledge, or that refuses the apply. */
export type ApplyIssue =
  | { kind: "slot"; key: string; groupId: string; conflict: Conflict }
  | { kind: "lesson"; key: string; lessonId: string; conflict: Conflict }
  | {
      kind: "maxHours";
      key: string;
      teacherId: string;
      minutes: number;
      maxMinutes: number;
    };

export type ApplyCounts = {
  groups: { assigned: number; changed: number; unassigned: number };
  slots: { created: number; ended: number; deleted: number };
  lessons: {
    created: number;
    repointed: number;
    removed: number;
    cancelled: number;
  };
  overridden: number;
  workloadRange: { minMinutes: number; maxMinutes: number };
};

export type ApplyResult =
  | {
      ok: true;
      published: boolean;
      counts: ApplyCounts;
      /** Blocking conflicts only between live slots the draft leaves alone. */
      preExisting: ApplyIssue[];
    }
  | {
      ok: false;
      reason: "BLOCKING_CONFLICTS" | "UNACKNOWLEDGED_CONFLICTS";
      blocking: ApplyIssue[];
      unacknowledged: ApplyIssue[];
      preExisting: ApplyIssue[];
    };

export type ApplyRequest = {
  draftId: string;
  version: number;
  acknowledgedConflictKeys: string[];
  /** REPLACE only: publish the term too (else "save to the editor only"). */
  publish: boolean;
};

export type PreviewResult = {
  counts: ApplyCounts;
  issues: ApplyIssue[];
  blocking: ApplyIssue[];
  preExisting: ApplyIssue[];
  /** Teachers whose lessons change (old and new). */
  teacherIds: string[];
  /** Students of the groups that get a slot or another teacher. */
  studentCount: number;
  /** Active replacement bookings into lessons that get a new teacher. */
  replacementBookings: number;
};

/** One group's change in a published term. */
type GroupPlan =
  | { kind: "new"; groupId: string; teacherId: string; slots: SlotInfo[] }
  | { kind: "end"; groupId: string; slots: SlotInfo[] }
  | {
      kind: "change";
      groupId: string;
      oldTeacherId: string | null;
      teacherId: string;
      plan: ReturnType<typeof planGroupTeacherChange>;
    };

class PreviewRollback extends Error {
  constructor(readonly result: PreviewResult) {
    super("preview");
  }
}

/**
 * Applies the draft (§5.6): one transaction holding the timetable lock and
 * the draft row; everything is re-checked against current data.
 */
export async function applyDraft(
  db: SchoolDb,
  actor: Actor,
  request: ApplyRequest,
  now = new Date(),
): Promise<ApplyResult> {
  return inTransaction(db, async (tx, schoolId) => {
    const outcome = await applyIn(tx, schoolId, actor, request, now, false);
    return outcome.result;
  });
}

/**
 * What `applyDraft` would do, in a transaction that is always rolled back
 * (§5.6 Preview). Information, not a reservation.
 */
export async function previewApply(
  db: SchoolDb,
  actor: Actor,
  request: Pick<ApplyRequest, "draftId" | "publish">,
  now = new Date(),
): Promise<PreviewResult> {
  try {
    await inTransaction(db, async (tx, schoolId) => {
      const outcome = await applyIn(
        tx,
        schoolId,
        actor,
        { ...request, version: -1, acknowledgedConflictKeys: [] },
        now,
        true,
      );
      throw new PreviewRollback(outcome.preview!);
    });
  } catch (error) {
    if (error instanceof PreviewRollback) return error.result;
    throw error;
  }
  throw new Error("unreachable");
}

async function applyIn(
  tx: Tx,
  schoolId: string,
  actor: Actor,
  request: ApplyRequest,
  now: Date,
  preview: boolean,
): Promise<{ result: ApplyResult; preview?: PreviewResult }> {
  // 1. The draft, current data and the refusals that need no checking.
  const draft = await lockDraft(
    tx,
    schoolId,
    request.draftId,
    preview ? null : request.version,
  );
  await assertNoRun(tx, draft.termId, now);
  const assignments = await draftAssignments(tx, draft.id);
  const { loaded, input } = await loadSnapshot(
    tx,
    draft.termId,
    now,
    draft.mode,
    effectiveOf(draft),
    assignments,
  );
  const { term, today, context } = loaded;
  const D = effectiveOf(draft);
  if (draft.mode === "REPLACE" && term.publishedAt) {
    throw new GeneratorError("TERM_PUBLISHED", "The term is published");
  }
  if (draft.mode !== "REPLACE" && (!D || D <= today)) {
    throw new GeneratorError(
      "EFFECTIVE_DATE_PASSED",
      "The effective date has passed",
    );
  }
  const archived = new Set(
    input.teachers.filter((t) => t.archived).map((t) => t.id),
  );
  if (assignments.some((a) => a.teacherId && archived.has(a.teacherId))) {
    throw new GeneratorError("TEACHER_ARCHIVED", "A teacher is archived");
  }
  const evaluation = evaluateDraft(input);
  const assigned = new Map(
    evaluation.assignments.map((a) => [a.groupId, a.teacherId]),
  );
  const included = evaluation.readiness.groups.filter(isIncluded);

  // 2. The would-be timetable.
  const termId = term.id;
  const timeZone = context.school.timeZone;
  let slots: SlotInfo[] =
    draft.mode === "REPLACE"
      ? context.slots.filter((s) => s.termId !== termId)
      : [...context.slots];
  let lessons: LessonInfo[] = [...context.lessons];
  /** Slots the draft creates or changes, by their would-be id. */
  const touched = new Map<string, { groupId: string }>();
  const plans: GroupPlan[] = [];
  const checkLessonIds: { lessonId: string; teacherId: string }[] = [];

  for (const group of included) {
    const teacherId = assigned.get(group.groupId) ?? null;
    const live = group.times.filter((t) => t.liveSlotId !== null);
    if (live.length === 0) {
      if (!teacherId) continue;
      const created = group.times.map((t) => timeAsSlot(t, termId, teacherId));
      for (const slot of created)
        touched.set(slot.id, { groupId: group.groupId });
      slots.push(...created);
      plans.push({
        kind: "new",
        groupId: group.groupId,
        teacherId,
        slots: created,
      });
      continue;
    }
    const ids = new Set(live.map((t) => t.liveSlotId!));
    const groupSlots = context.slots.filter(
      (s) => s.termId === termId && s.groupId === group.groupId,
    );
    if (!teacherId) {
      // Only the admin's "No teacher" ends a running group's lessons
      // (§5.3); a group nobody could take keeps its slots as they are.
      const row = assignments.find((a) => a.groupId === group.groupId);
      if (!row?.locked || row.origin !== "MANUAL") continue;
      const ended = groupSlots
        .filter((s) => ids.has(s.id))
        .map((s) => ({ ...s, validUntil: addDays(D!, -1) }));
      const endedIds = new Set(ended.map((s) => s.id));
      slots = slots.map((s) => ended.find((e) => e.id === s.id) ?? s);
      lessons = lessons.filter(
        (l) =>
          !(
            l.timetableSlotId &&
            endedIds.has(l.timetableSlotId) &&
            l.occurrenceDate &&
            l.occurrenceDate >= D! &&
            l.startsAt > now
          ),
      );
      plans.push({ kind: "end", groupId: group.groupId, slots: ended });
      continue;
    }
    if (!group.mixedTeachers && group.currentTeacherId === teacherId) continue;
    const groupLessons = await loadExistingLessons(tx, {
      groupId: group.groupId,
      termId,
      OR: [
        { timetableSlotId: { in: groupSlots.map((s) => s.id) } },
        // A day early: D's local midnight is before its UTC midnight; the
        // plan keeps only those on or after D in the school's time zone.
        {
          timetableSlotId: null,
          startsAt: { gte: fromIsoDate(addDays(D!, -1)) },
        },
      ],
    });
    const plan = planGroupTeacherChange({
      slots: groupSlots,
      lessons: groupLessons,
      oldTeacherId: group.currentTeacherId,
      newTeacherId: teacherId,
      from: D!,
      now,
      timeZone,
    });
    plans.push({
      kind: "change",
      groupId: group.groupId,
      oldTeacherId: group.currentTeacherId,
      teacherId,
      plan,
    });
    // In the would-be calendar the new slots carry the draft's ids, so
    // conflict keys match the ones the review showed.
    const nextId = new Map<string, string>();
    for (const change of plan.slots) {
      const old = change.kind === "update" ? change.slot : change.ended;
      const next = change.kind === "update" ? change.slot : change.next;
      const id = `draft:slot:${old.id}`;
      nextId.set(old.id, id);
      slots = slots.filter((s) => s.id !== old.id);
      if (change.kind === "split") slots.push(change.ended);
      slots.push({ ...next, id });
      touched.set(id, { groupId: group.groupId });
    }
    const repoint = new Map(plan.repoint.map((r) => [r.lessonId, r]));
    const adHoc = new Map(plan.adHoc.map((a) => [a.lessonId, a]));
    lessons = lessons.map((l) => {
      const r = repoint.get(l.id);
      const a = adHoc.get(l.id);
      if (!r && !a) return l;
      const clear = r?.clearSubstitute || a?.clearSubstitute;
      return {
        ...l,
        timetableSlotId: r ? nextId.get(r.fromSlotId)! : l.timetableSlotId,
        teacherId: !r || r.setTeacher ? teacherId : l.teacherId,
        substituteTeacherId: clear ? null : l.substituteTeacherId,
      };
    });
    for (const id of plan.checkLessons)
      checkLessonIds.push({ lessonId: id, teacherId });
  }

  // 3. Check it.
  const calendar = buildCalendar({ ...context, slots, lessons });
  const byId = new Map(slots.map((s) => [s.id, s]));
  const blocking: ApplyIssue[] = [];
  const preExisting: ApplyIssue[] = [];
  const overridable: ApplyIssue[] = [];
  for (const [slotId, conflicts] of checkTimetable(calendar, termId)) {
    const slot = byId.get(slotId)!;
    const mine = touched.has(slotId);
    for (const conflict of conflicts) {
      const issue: ApplyIssue = {
        kind: "slot",
        key: `${slot.groupId}|${slot.weekday}|${slot.startMinute}|${slot.endMinute}|${conflict.key}`,
        groupId: slot.groupId,
        conflict,
      };
      const counterpart = conflict.refs.counterpart;
      const involvesDraft =
        mine || (counterpart?.kind === "slot" && touched.has(counterpart.id));
      if (conflict.severity === "blocking") {
        (involvesDraft ? blocking : preExisting).push(issue);
      } else if (mine) {
        overridable.push(issue);
      }
    }
  }
  const lessonsById = new Map(lessons.map((l) => [l.id, l]));
  for (const { lessonId } of checkLessonIds) {
    const lesson = lessonsById.get(lessonId);
    if (!lesson || lesson.status !== "SCHEDULED") continue;
    for (const conflict of checkLesson(calendar, lesson)) {
      const issue: ApplyIssue = {
        kind: "lesson",
        key: `lesson:${lessonId}|${conflict.key}`,
        lessonId,
        conflict,
      };
      (conflict.severity === "blocking" ? blocking : overridable).push(issue);
    }
  }
  for (const w of evaluation.teacherWarnings) {
    overridable.push({
      kind: "maxHours",
      key: w.key,
      teacherId: w.teacherId,
      minutes: w.minutes,
      maxMinutes: w.maxMinutes,
    });
  }
  const acknowledged = new Set(request.acknowledgedConflictKeys);
  const unacknowledged = overridable.filter((i) => !acknowledged.has(i.key));
  if (!preview && (blocking.length > 0 || unacknowledged.length > 0)) {
    return {
      result: {
        ok: false,
        reason:
          blocking.length > 0
            ? "BLOCKING_CONFLICTS"
            : "UNACKNOWLEDGED_CONFLICTS",
        blocking,
        unacknowledged,
        preExisting,
      },
    };
  }

  // 4–5. Slots and lessons.
  const counts: ApplyCounts = {
    groups: {
      assigned: [...assigned.values()].filter((t) => t !== null).length,
      changed: plans.filter((p) => p.kind === "change").length,
      unassigned: [...assigned.values()].filter((t) => t === null).length,
    },
    slots: { created: 0, ended: 0, deleted: 0 },
    lessons: { created: 0, repointed: 0, removed: 0, cancelled: 0 },
    overridden: overridable.length,
    workloadRange: {
      minMinutes: evaluation.final.minMinutes,
      maxMinutes: evaluation.final.maxMinutes,
    },
  };
  let lessonChanges: LessonChanges = { created: 0, removed: 0, cancelled: 0 };
  const createSlot = async (slot: SlotInfo) => {
    const created = await tx.timetableSlot.create({
      data: {
        schoolId,
        termId,
        groupId: slot.groupId,
        teacherId: slot.teacherId,
        roomId: slot.roomId,
        weekday: slot.weekday,
        startMinute: slot.startMinute,
        endMinute: slot.endMinute,
        validFrom: slot.validFrom ? fromIsoDate(slot.validFrom) : null,
        validUntil: slot.validUntil ? fromIsoDate(slot.validUntil) : null,
      },
      select: { id: true },
    });
    counts.slots.created++;
    return { ...slot, id: created.id };
  };

  let published = false;
  if (draft.mode === "REPLACE") {
    const { count } = await tx.timetableSlot.deleteMany({ where: { termId } });
    counts.slots.deleted = count;
    for (const plan of plans) {
      if (plan.kind === "new")
        for (const slot of plan.slots) await createSlot(slot);
    }
    // A preview with blocking conflicts shows them; publishing would refuse.
    if (request.publish && !(preview && blocking.length > 0)) {
      const result = await publishTermIn(tx, schoolId, actor, termId, now);
      if (!result.ok) {
        throw new Error("Publishing a checked draft found blocking conflicts");
      }
      lessonChanges = result.lessons;
      published = true;
    }
  } else {
    const synced: SlotInfo[] = [];
    for (const plan of plans) {
      if (plan.kind === "new") {
        for (const slot of plan.slots) synced.push(await createSlot(slot));
      } else if (plan.kind === "end") {
        for (const slot of plan.slots) {
          await tx.timetableSlot.update({
            where: { id: slot.id },
            data: { validUntil: fromIsoDate(slot.validUntil!) },
          });
          counts.slots.ended++;
          synced.push(slot);
        }
      } else {
        const nextIds = new Map<string, string>();
        for (const change of plan.plan.slots) {
          if (change.kind === "update") {
            await tx.timetableSlot.update({
              where: { id: change.slot.id },
              data: { teacherId: change.slot.teacherId },
            });
            nextIds.set(change.slot.id, change.slot.id);
            synced.push(change.slot);
          } else {
            await tx.timetableSlot.update({
              where: { id: change.ended.id },
              data: { validUntil: fromIsoDate(change.ended.validUntil!) },
            });
            counts.slots.ended++;
            const next = await createSlot({ ...change.next, id: "" });
            nextIds.set(change.ended.id, next.id);
            synced.push(change.ended, next);
          }
        }
        for (const r of plan.plan.repoint) {
          await tx.lesson.update({
            where: { id: r.lessonId },
            data: {
              timetableSlotId: nextIds.get(r.fromSlotId)!,
              ...(r.setTeacher && { teacherId: plan.teacherId }),
              ...(r.clearSubstitute && { substituteTeacherId: null }),
            },
          });
          counts.lessons.repointed++;
        }
        for (const a of plan.plan.adHoc) {
          await tx.lesson.update({
            where: { id: a.lessonId },
            data: {
              teacherId: plan.teacherId,
              ...(a.clearSubstitute && { substituteTeacherId: null }),
            },
          });
          counts.lessons.repointed++;
        }
      }
    }
    if (synced.length > 0) {
      lessonChanges = await syncSlots(tx, loaded, synced, D!, now, "slots");
    }
    // A slot ended before it ever took effect, with no lessons, goes.
    for (const plan of plans) {
      if (plan.kind !== "end") continue;
      for (const slot of plan.slots) {
        const start = context.slots.find((s) => s.id === slot.id)?.validFrom;
        if (!start || start <= slot.validUntil!) continue;
        const remaining = await tx.lesson.count({
          where: { timetableSlotId: slot.id },
        });
        if (remaining === 0) {
          await tx.timetableSlot.delete({ where: { id: slot.id } });
          counts.slots.deleted++;
        }
      }
    }
  }
  counts.lessons.created = lessonChanges.created;
  counts.lessons.removed = lessonChanges.removed;
  counts.lessons.cancelled = lessonChanges.cancelled;

  if (preview) {
    const teacherIds = new Set<string>();
    const repointed: string[] = [];
    for (const p of plans) {
      if (p.kind === "new") teacherIds.add(p.teacherId);
      if (p.kind === "end")
        for (const s of p.slots) teacherIds.add(s.teacherId);
      if (p.kind === "change") {
        teacherIds.add(p.teacherId);
        if (p.oldTeacherId) teacherIds.add(p.oldTeacherId);
        repointed.push(...p.plan.repoint.map((r) => r.lessonId));
      }
    }
    const groupIds = plans.map((p) => p.groupId);
    const [students, bookings] = await Promise.all([
      tx.groupMembership.count({
        where: { groupId: { in: groupIds }, leftAt: null },
      }),
      tx.replacementRequest.count({
        where: {
          targetLessonId: { in: repointed },
          status: { in: [...ACTIVE_REPLACEMENT] },
        },
      }),
    ]);
    return {
      result: { ok: true, published, counts, preExisting },
      preview: {
        counts,
        issues: overridable,
        blocking,
        preExisting,
        teacherIds: [...teacherIds].sort(),
        studentCount: students,
        replacementBookings: bookings,
      },
    };
  }

  // 6. Audit, then the draft goes.
  await audit(
    tx,
    schoolId,
    actor,
    "timetable_draft.applied",
    "TimetableDraft",
    draft.id,
    {
      termId,
      mode: draft.mode,
      effectiveFrom: D,
      published,
      ...counts,
      overridden: overridable.map((i) => i.key),
      preExisting: preExisting.map((i) => i.key),
    },
  );
  await tx.timetableDraft.delete({ where: { id: draft.id } });
  return { result: { ok: true, published, counts, preExisting } };
}
