import { getTranslations } from "next-intl/server";
import { connection } from "next/server";

import { checkAccess } from "@/server/auth/access";
import { getViewer } from "@/server/auth/session";
import { exportReport } from "@/server/reports/admin";
import { csvFileName, reportCsv } from "@/server/reports/csv";
import { REPORTS, ReportError } from "@/server/reports/rules";
import { parseReportQuery } from "@/server/reports/schema";

const status = (code: number) => new Response(null, { status: code });

/**
 * The report exports (docs/architecture/phase6-rules.md §5):
 * `GET /api/admin/reports/<report>.csv?<the page's query>`. Admins of the
 * school only: signed out → 401, teacher or student → 403, another
 * school's (or an unknown) id → 404. A bad period or too many rows → 422
 * with `{ code, count? }`, and nothing is downloaded.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/admin/reports/[report]">,
) {
  await connection();
  // The proxy doesn't cover /api: answer 401/403 here instead of the
  // login redirect and forbidden page `requireRole` gives pages.
  switch (checkAccess(await getViewer(), ["ADMIN"])) {
    case "unauthenticated":
      return status(401);
    case "forbidden":
      return status(403);
  }
  const segment = (await params).report;
  const report = REPORTS.find((r) => `${r}.csv` === segment);
  if (!report) return status(404);

  try {
    const { input } = parseReportQuery(new URL(request.url).searchParams);
    const data = await exportReport(report, input);
    const t = await getTranslations(`reports.csv.${report}`);
    const header = (key: string) =>
      (t as unknown as (k: string) => string)(key);
    const body = reportCsv(report, data.rows, header);
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFileName(report, data.period.from, data.period.to)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (!(error instanceof ReportError)) throw error;
    if (error.code === "NOT_FOUND") return status(404);
    return Response.json(
      {
        code: error.code,
        ...(error.count === undefined ? {} : { count: error.count }),
      },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
}
