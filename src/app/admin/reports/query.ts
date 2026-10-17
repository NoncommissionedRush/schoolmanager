import { notFound } from "next/navigation";

import { ReportError } from "@/server/reports/rules";
import { parseReportQuery, type ReportQuery } from "@/server/reports/schema";

/** The page's query; a malformed id is a 404, like another school's. */
export async function reportQuery(
  searchParams: Promise<Record<string, string | string[] | undefined>>,
): Promise<ReportQuery> {
  try {
    return parseReportQuery(await searchParams);
  } catch (error) {
    return notFoundOn(error);
  }
}

/** `NOT_FOUND` from the loader → the 404 page; anything else rethrows. */
export function notFoundOn(error: unknown): never {
  if (error instanceof ReportError && error.code === "NOT_FOUND") notFound();
  throw error;
}
