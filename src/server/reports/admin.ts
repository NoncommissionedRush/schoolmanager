import "server-only";

// The report entry points (docs/architecture/phase6-rules.md §6). Each
// starts with `requireRole("ADMIN")` (via `adminContext`) and queries
// through the school-scoped client. The page and the CSV route call these
// same functions. Only src/app/admin/**, src/app/api/admin/reports/** and
// src/server/reports/** may import this file (reports.test.ts).

import { adminContext } from "@/server/admin/context";

import {
  exportReportData,
  type LoadedReport,
  loadReportData,
  type ReportExport,
} from "./admin-data";
import type { ReportKind } from "./rules";
import type { ReportInput } from "./schema";

export type {
  LoadedReport,
  ReportExport,
  ReportOptions,
  ReportResults,
} from "./admin-data";

/** A report page (`/admin/reports/*`). */
export async function loadReport<K extends ReportKind>(
  report: K,
  input: ReportInput,
): Promise<LoadedReport<K>> {
  const { db } = await adminContext();
  return loadReportData(db, report, input, new Date());
}

/** A CSV export: the same rows, limited and audited (§5). */
export async function exportReport<K extends ReportKind>(
  report: K,
  input: ReportInput,
): Promise<ReportExport<K>> {
  const { db, schoolId, actor } = await adminContext();
  return exportReportData(
    db,
    { userId: actor.userId, schoolId },
    report,
    input,
    new Date(),
  );
}
