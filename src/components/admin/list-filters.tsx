"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";

export type FilterSelect = {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  /** Value meaning "no filter" (omitted from the URL). */
  defaultValue?: string;
};

/**
 * Filter bar (§5.1): debounced search (300 ms) and selects, all reflected
 * in the URL. Changing a filter goes back to page 1.
 */
export function ListFilters({
  searchLabel,
  selects = [],
  status = true,
  count,
}: {
  searchLabel?: string;
  selects?: FilterSelect[];
  status?: boolean;
  /** Announced after filtering (role="status"). */
  count?: string;
}) {
  const t = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  function update(name: string, value: string, defaultValue = "") {
    const next = new URLSearchParams(params.toString());
    if (value && value !== defaultValue) next.set(name, value);
    else next.delete(name);
    next.delete("page");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  const allSelects: FilterSelect[] = [
    ...selects,
    ...(status
      ? [
          {
            name: "status",
            label: t("status.label"),
            defaultValue: "active",
            options: [
              { value: "active", label: t("status.active") },
              { value: "archived", label: t("status.archived") },
              { value: "all", label: t("status.all") },
            ],
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-wrap items-end gap-3" role="search">
      {searchLabel && (
        <div className="relative w-full max-w-xs">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={q}
            className="pl-8"
            onChange={(event) => {
              const value = event.target.value;
              setQ(value);
              clearTimeout(timer.current);
              timer.current = setTimeout(() => update("q", value.trim()), 300);
            }}
          />
        </div>
      )}
      {allSelects.map((select) => (
        <label key={select.name} className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{select.label}</span>
          <NativeSelect
            value={params.get(select.name) ?? select.defaultValue ?? ""}
            onChange={(event) =>
              update(select.name, event.target.value, select.defaultValue)
            }
          >
            {select.options.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ))}
      {count !== undefined && (
        <p role="status" className="sr-only">
          {count}
        </p>
      )}
    </div>
  );
}
