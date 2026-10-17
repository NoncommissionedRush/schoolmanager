"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";

export type ReportFilterSelect = {
  name: "teacher" | "group" | "student";
  label: string;
  options: { value: string; label: string }[];
};

const CUSTOM = "custom";

/**
 * Period and filters of a report (reports.md §4.0), all kept in the URL.
 * Selects apply at once; custom dates apply once both are set (debounced).
 * The server validates the period and passes `rangeError` back.
 */
export function ReportFilters({
  terms,
  period,
  selects,
  rangeError,
  resetHref,
  showReset,
}: {
  terms: { id: string; label: string }[];
  /** The period shown: a term, or custom dates. Null without one. */
  period: { termId: string | null; from: string; to: string } | null;
  selects: ReportFilterSelect[];
  rangeError?: string;
  resetHref: string;
  showReset: boolean;
}) {
  const t = useTranslations("reports.filter");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const errorId = useId();
  const customInUrl = params.has("from") || params.has("to");
  const [custom, setCustom] = useState(customInUrl || period?.termId === null);
  const [from, setFrom] = useState(params.get("from") ?? period?.from ?? "");
  const [to, setTo] = useState(params.get("to") ?? period?.to ?? "");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function replace(change: (next: URLSearchParams) => void) {
    const next = new URLSearchParams(params.toString());
    change(next);
    next.delete("page");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }

  function setDates(nextFrom: string, nextTo: string) {
    clearTimeout(timer.current);
    if (!nextFrom || !nextTo) return;
    timer.current = setTimeout(
      () =>
        replace((next) => {
          next.delete("term");
          next.set("from", nextFrom);
          next.set("to", nextTo);
        }),
      400,
    );
  }

  const periodValue = custom ? CUSTOM : (period?.termId ?? "");

  return (
    <div
      className="flex flex-wrap items-end gap-3"
      role="search"
      aria-label={t("label")}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t("period")}</span>
        <NativeSelect
          value={periodValue}
          onChange={(event) => {
            const value = event.target.value;
            if (value === CUSTOM) {
              setCustom(true);
              setDates(from, to);
              return;
            }
            setCustom(false);
            replace((next) => {
              next.delete("from");
              next.delete("to");
              next.set("term", value);
            });
          }}
        >
          {terms.map((term) => (
            <NativeSelectOption key={term.id} value={term.id}>
              {term.label}
            </NativeSelectOption>
          ))}
          <NativeSelectOption value={CUSTOM}>{t("custom")}</NativeSelectOption>
        </NativeSelect>
      </label>
      {custom && (
        <>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t("from")}</span>
            <Input
              type="date"
              value={from}
              aria-invalid={rangeError ? true : undefined}
              aria-describedby={rangeError ? errorId : undefined}
              onChange={(event) => {
                setFrom(event.target.value);
                setDates(event.target.value, to);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t("to")}</span>
            <Input
              type="date"
              value={to}
              aria-invalid={rangeError ? true : undefined}
              aria-describedby={rangeError ? errorId : undefined}
              onChange={(event) => {
                setTo(event.target.value);
                setDates(from, event.target.value);
              }}
            />
          </label>
        </>
      )}
      {selects.map((select) => (
        <label key={select.name} className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{select.label}</span>
          <NativeSelect
            value={params.get(select.name) ?? ""}
            onChange={(event) =>
              replace((next) => {
                if (event.target.value)
                  next.set(select.name, event.target.value);
                else next.delete(select.name);
              })
            }
          >
            <NativeSelectOption value="">{t("any")}</NativeSelectOption>
            {select.options.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ))}
      {showReset && (
        <Link
          href={resetHref}
          scroll={false}
          className={buttonVariants({ variant: "ghost" })}
        >
          {t("reset")}
        </Link>
      )}
      {rangeError && (
        <p id={errorId} className="w-full text-sm text-destructive">
          {rangeError}
        </p>
      )}
    </div>
  );
}
