// Teacher-assignment generator (docs/architecture/generator.md): pure,
// deterministic, free of Prisma and Next.js.

export { DEFAULT_MAX_ITERATIONS, DEFAULT_TIME_LIMIT_MS } from "./assign";
export type { PickerSection, TeacherOption } from "./explain";
export {
  assignTeachers,
  assignTeachersSteps,
  checkGeneratorReadiness,
  draftTeacherOptions,
  evaluateDraft,
  fingerprintPayload,
  GENERATOR_HARD_CONFLICTS,
} from "./generate";
export { timeAsSlot } from "./readiness";
export { compareObjectives } from "./score";
export * from "./types";
