import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/** h1 + one-line description + primary action (§5.1). */
export function PageHeader({
  title,
  description,
  actions,
  back,
  badges,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
  badges?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {back && (
        <Link
          href={back.href}
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold break-words">{title}</h1>
            {badges}
          </div>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export async function ArchivedBadge() {
  const t = await getTranslations("common");
  return <Badge variant="secondary">{t("archivedBadge")}</Badge>;
}

/** Table card with a screen-reader caption (§8). */
export function TableCard({ children }: { children: ReactNode }) {
  return <Card className="overflow-hidden p-0">{children}</Card>;
}

/** "No {entities} match your filters." + Clear filters, or archived-empty. */
export async function NoResults({
  entities,
  archived,
  clearHref,
}: {
  entities: string;
  archived?: boolean;
  clearHref: string;
}) {
  const t = await getTranslations("common");
  return (
    <Card className="flex flex-col items-center gap-3 py-10 text-center">
      <p className="text-sm text-muted-foreground">
        {archived
          ? t("noArchived", { entities })
          : t("noResultsFor", { entities })}
      </p>
      {!archived && (
        <Link
          href={clearHref}
          className={buttonVariants({ variant: "outline" })}
        >
          {t("clearFilters")}
        </Link>
      )}
    </Card>
  );
}

/** Previous / Next + "Showing 1–25 of 132". */
export async function Pagination({
  window,
  total,
  hrefFor,
}: {
  window: { page: number; pages: number; from: number; to: number };
  total: number;
  hrefFor: (page: number) => string;
}) {
  const t = await getTranslations("common.pagination");
  return (
    <nav
      aria-label={t("label")}
      className="flex flex-wrap items-center justify-between gap-2 text-sm"
    >
      <p className="text-muted-foreground">
        {t("summary", { from: window.from, to: window.to, total })}
      </p>
      {window.pages > 1 && (
        <div className="flex gap-2">
          {window.page > 1 ? (
            <Link
              href={hrefFor(window.page - 1)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              {t("previous")}
            </Link>
          ) : null}
          {window.page < window.pages ? (
            <Link
              href={hrefFor(window.page + 1)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              {t("next")}
            </Link>
          ) : null}
        </div>
      )}
    </nav>
  );
}

/** Builds a list URL keeping the current filters. */
export function listHref(
  pathname: string,
  params: Record<string, string | number | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "" && value !== 1) {
      if (!(key === "status" && value === "active")) {
        search.set(key, String(value));
      }
    }
  }
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}
