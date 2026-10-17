import { ChartColumn, Info } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { ToneAlert } from "@/components/absences/tone";
import { PageHeader } from "@/components/admin/list";
import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getSchoolFormatter } from "@/i18n/school-format";
import type { LoadedReport } from "@/server/reports/admin";
import {
  REPORT_MAX_RANGE_DAYS,
  REPORT_MAX_ROWS,
  type ReportKind,
} from "@/server/reports/rules";
import { type ReportInput, reportSearch } from "@/server/reports/schema";

import { type ExportLink, ExportButton } from "./export-button";
import { type ReportFilterSelect, ReportFilters } from "./report-filters";

type Translate = (key: string, values?: Record<string, unknown>) => string;

/** "12 h 30 min" (`reports.duration`); "0 h" for nothing. */
export function formatDuration(t: Translate, minutes: number): string {
  const text = t("duration", {
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
  })
    .replace(/\s+/g, " ")
    .trim();
  return text || t("durationZero");
}

export async function reportTranslator(): Promise<Translate> {
  return (await getTranslations("reports")) as unknown as Translate;
}

/** Summary cards (reports.md §4.0, §6: a `<dl>`). */
export function SummaryCards({
  items,
}: {
  items: { label: string; value: ReactNode; detail?: ReactNode }[];
}) {
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label} className="flex flex-col gap-1 p-4">
          <dt className="text-sm text-muted-foreground">{item.label}</dt>
          <dd className="text-2xl font-semibold tabular-nums">{item.value}</dd>
          {item.detail && (
            <dd className="text-sm text-muted-foreground">{item.detail}</dd>
          )}
        </Card>
      ))}
    </dl>
  );
}

/** Filter options with the "(archived)" tag, as select options. */
export function filterOptions(
  t: Translate,
  items: { id: string; name: string; archived: boolean }[],
) {
  return items.map((item) => ({
    value: item.id,
    label: item.archived
      ? t("filter.archived", { name: item.name })
      : item.name,
  }));
}

/**
 * The frame shared by every report page (reports.md §4.0, §4.4): header
 * with _Export CSV_, period and filters, the "until today" note, the range
 * error and the no-term / no-data states, and the footnotes. `children` is
 * the summary and table, shown when the report loaded and has rows.
 */
export async function ReportShell({
  loaded,
  input,
  basePath,
  title,
  description,
  caption,
  back,
  exports,
  selects,
  empty,
  footnotes = [],
  filtered = Object.keys(input).length > 0,
  children,
}: {
  loaded: LoadedReport<ReportKind>;
  input: ReportInput;
  basePath: string;
  title: ReactNode;
  description?: ReactNode;
  caption?: ReactNode;
  back: { href: string; label: string };
  /** Export links: the report and query of each CSV. */
  exports: { report: ReportKind; label: string }[];
  selects: ReportFilterSelect[];
  empty: boolean;
  footnotes?: string[];
  /** Anything differs from the defaults (shows _Reset filters_). */
  filtered?: boolean;
  children: ReactNode;
}) {
  const t = await reportTranslator();
  const format = await getSchoolFormatter({ timezone: loaded.timeZone });
  const period = loaded.status === "ok" ? loaded.period : null;
  const links: ExportLink[] = exports.map((e) => ({
    href: `/api/admin/reports/${e.report}.csv${reportSearch(input)}`,
    label: e.label,
  }));
  const rangeError =
    loaded.status === "error" && loaded.code === "RANGE_TOO_LONG"
      ? t("error.rangeTooLong", { days: REPORT_MAX_RANGE_DAYS })
      : loaded.status === "error" && loaded.code === "INVALID_RANGE"
        ? t("error.invalidRange")
        : undefined;
  const noTerm = loaded.status === "error" && loaded.code === "NO_TERM";

  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <PageHeader
        back={back}
        title={title}
        description={description}
        actions={
          loaded.status === "ok" && (
            <ExportButton links={links} max={REPORT_MAX_ROWS} />
          )
        }
      />
      {caption && <p className="text-sm font-medium">{caption}</p>}
      {noTerm && !filtered ? (
        <EmptyState icon={ChartColumn} title={t("empty.noTerm")}>
          <Link
            href="/admin/settings/terms"
            className={buttonVariants({ variant: "outline" })}
          >
            {t("empty.termsLink")}
          </Link>
        </EmptyState>
      ) : (
        <>
          <ReportFilters
            key={`${input.termId}|${input.from}|${input.to}`}
            terms={loaded.options.terms.map((term) => ({
              id: term.id,
              label: term.published
                ? t("filter.term", { term: term.name })
                : t("filter.termDraft", { term: term.name }),
            }))}
            period={
              period ??
              (input.from && input.to
                ? { termId: null, from: input.from, to: input.to }
                : null)
            }
            selects={selects}
            rangeError={rangeError}
            resetHref={basePath}
            showReset={filtered}
          />
          {loaded.status === "ok" && loaded.untilToday && (
            <ToneAlert tone="info" icon={Info}>
              {t("untilToday")}
            </ToneAlert>
          )}
          {loaded.status === "ok" &&
            (empty ? (
              <EmptyState
                icon={ChartColumn}
                title={t("empty.title")}
                description={t("empty.description")}
              />
            ) : (
              children
            ))}
          {noTerm && (
            <p className="text-sm text-muted-foreground">{t("empty.noTerm")}</p>
          )}
        </>
      )}
      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
        {footnotes.map((note) => (
          <p key={note}>{note}</p>
        ))}
        <p>{t("laterCorrections")}</p>
        <p>
          {t("asOf", {
            dateTime: format.dateTime(loaded.asOf, {
              day: "numeric",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
          })}
        </p>
      </div>
    </div>
  );
}
