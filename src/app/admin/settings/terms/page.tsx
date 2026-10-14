import { Suspense } from "react";
import { CalendarRange } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { ListFilters } from "@/components/admin/list-filters";
import { PageHeader, TableCard } from "@/components/admin/list";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatWeekRange } from "@/lib/i18n/dates";
import { adminContext } from "@/server/admin/context";
import {
  isOutsideTerm,
  touchedPublishedTerms,
} from "@/server/admin/holidays/schema";
import { listHolidays } from "@/server/admin/holidays/service";
import { param } from "@/server/admin/list";
import { schoolToday } from "@/server/admin/shared";
import { listTerms } from "@/server/admin/terms/service";
import { toIsoDate } from "@/server/scheduling";

import {
  HolidayRowActions,
  NewHolidayButton,
  NewTermButton,
  TermRowActions,
} from "./terms-client";
import { TableSkeleton } from "@/components/admin/table-skeleton";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function TermsPage({ searchParams }: PageProps<"/admin/settings/terms">) {
  const { db, viewer } = await adminContext();
  const t = await getTranslations("terms");
  const th = await getTranslations("holidays");
  const tc = await getTranslations("common");
  const locale = await getLocale();
  const today = toIsoDate(schoolToday(viewer.school.timezone));
  const terms = await listTerms(db, today);

  const scopeParam = param(await searchParams, "appliesTo");
  const scope =
    scopeParam === "school" ||
    (UUID.test(scopeParam) && terms.some((term) => term.id === scopeParam))
      ? scopeParam
      : null;
  const [holidays, anyHoliday] = await Promise.all([
    listHolidays(db, scope),
    db.holiday.count(),
  ]);

  const termOptions = terms.map((term) => ({
    id: term.id,
    name: term.name,
    startDate: term.startDate,
    endDate: term.endDate,
    published: term.published,
  }));
  const termById = new Map(terms.map((term) => [term.id, term]));
  const range = (startDate: string, endDate: string) =>
    formatWeekRange(locale, startDate, endDate);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={terms.length > 0 && <NewTermButton terms={termOptions} />}
      />
      {terms.length === 0 ? (
        <div className="flex flex-col items-center gap-4">
          <EmptyState
            icon={CalendarRange}
            title={t("empty.title")}
            description={t("empty.description")}
          />
          <NewTermButton terms={termOptions} label={t("empty.action")} />
        </div>
      ) : (
        <TableCard>
          <Table>
            <TableCaption className="sr-only">
              {t("caption", { count: terms.length })}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("col.name")}</TableHead>
                <TableHead>{t("col.dates")}</TableHead>
                <TableHead>{t("col.status")}</TableHead>
                <TableHead>{t("col.slots")}</TableHead>
                <TableHead>{t("col.holidays")}</TableHead>
                <TableHead>
                  <span className="sr-only">{tc("edit")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {terms.map((term) => (
                <TableRow key={term.id}>
                  <TableCell
                    className="max-w-xs truncate font-medium"
                    title={term.name}
                  >
                    {term.name}
                  </TableCell>
                  <TableCell>{range(term.startDate, term.endDate)}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {term.published ? (
                        <Badge className="border-success-border bg-success-surface text-success">
                          {t("status.published")}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">{t("status.draft")}</Badge>
                      )}
                      {term.current && (
                        <Badge className="border-info-border bg-info-surface text-info">
                          {t("status.current")}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>{term.slots}</TableCell>
                  <TableCell>{term.holidays}</TableCell>
                  <TableCell className="text-right">
                    <TermRowActions
                      term={{
                        id: term.id,
                        name: term.name,
                        startDate: term.startDate,
                        endDate: term.endDate,
                        published: term.published,
                        slots: term.slots,
                        holidays: term.holidays,
                        lessons: term.lessons,
                      }}
                      terms={termOptions}
                      today={today}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
      )}

      <section
        aria-labelledby="holidays-heading"
        className="flex flex-col gap-4"
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 id="holidays-heading" className="text-lg font-semibold">
            {th("title")}
          </h2>
          <NewHolidayButton terms={termOptions} />
        </div>
        {anyHoliday === 0 ? (
          <Card className="py-10 text-center text-sm text-muted-foreground">
            {th("empty")}
          </Card>
        ) : (
          <>
            <ListFilters
              status={false}
              count={th("caption", { count: holidays.length })}
              selects={[
                {
                  name: "appliesTo",
                  label: th("filter.label"),
                  defaultValue: "",
                  options: [
                    { value: "", label: th("filter.all") },
                    { value: "school", label: th("filter.school") },
                    ...terms.map((term) => ({
                      value: term.id,
                      label: term.name,
                    })),
                  ],
                },
              ]}
            />
            {holidays.length === 0 ? (
              <Card className="py-10 text-center text-sm text-muted-foreground">
                {th("noMatch")}
              </Card>
            ) : (
              <TableCard>
                <Table>
                  <TableCaption className="sr-only">
                    {th("caption", { count: holidays.length })}
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{th("col.name")}</TableHead>
                      <TableHead>{th("col.dates")}</TableHead>
                      <TableHead>{th("col.appliesTo")}</TableHead>
                      <TableHead>
                        <span className="sr-only">{tc("edit")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {holidays.map((holiday) => {
                      const term = holiday.termId
                        ? (termById.get(holiday.termId) ?? null)
                        : null;
                      return (
                        <TableRow key={holiday.id}>
                          <TableCell
                            className="max-w-xs truncate font-medium"
                            title={holiday.name}
                          >
                            {holiday.name}
                          </TableCell>
                          <TableCell>
                            <span className="flex flex-col">
                              {range(holiday.startDate, holiday.endDate)}
                              {isOutsideTerm(holiday, term) && (
                                <span className="text-xs text-muted-foreground">
                                  {th("outsideTerm")}
                                </span>
                              )}
                            </span>
                          </TableCell>
                          <TableCell>
                            {term ? term.name : th("scope.allTerms")}
                          </TableCell>
                          <TableCell className="text-right">
                            <HolidayRowActions
                              holiday={holiday}
                              terms={termOptions}
                              touchesPublished={
                                touchedPublishedTerms(holiday, termOptions)
                                  .length > 0
                              }
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableCard>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// Own Suspense boundary: client navigations between admin pages re-render
// below the shared layout, so the shell's boundary doesn't cover them.
export default function Page(props: Parameters<typeof TermsPage>[0]) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <TermsPage {...props} />
    </Suspense>
  );
}
