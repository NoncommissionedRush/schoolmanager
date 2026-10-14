"use client";

import { cn } from "cn";
import { useTranslations } from "next-intl";
import type { KeyboardEvent, ReactNode } from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { layoutColumn } from "@/server/timetable/week";

import { formatMinutes } from "./format";

/** 64 px per hour (app-layout.md §7.5). */
export const PX_PER_MINUTE = 64 / 60;
const SNAP = 15;
/** Blocks never shrink below a 24 px target (timetable.md §9). */
const MIN_BLOCK_PX = 24;

export type GridColumn = {
  key: string;
  title: ReactNode;
  subtitle?: ReactNode;
  current?: boolean;
  /** Striped background, e.g. a holiday; the label is in the header. */
  striped?: boolean;
  /** Decorative hatched ranges, e.g. a teacher's weekly unavailability. */
  hatched?: { startMinute: number; endMinute: number }[];
};

export type GridItem = {
  id: string;
  column: string;
  startMinute: number;
  endMinute: number;
  /** Renders the block; `compact` when it is shorter than 30 minutes. */
  render: (props: {
    style: React.CSSProperties;
    compact: boolean;
    tabIndex: number;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    "data-grid-item": string;
  }) => ReactNode;
  /** Label of the item inside a "+N more" popover. */
  overflowLabel: ReactNode;
  onOverflowSelect?: () => void;
};

/**
 * Week/day grid: a time axis plus one column per day or room, blocks
 * positioned by start and duration, overlapping blocks side by side
 * (max 3, then "+N more"). Used by the read-only views and the editor.
 */
export function TimeGrid({
  label,
  columns,
  items,
  hours,
  nowMinute,
  onEmptyClick,
  minColumnWidth = 140,
}: {
  label: string;
  columns: GridColumn[];
  items: GridItem[];
  hours: { startMinute: number; endMinute: number };
  /** Current-time line, in the column marked `current`. */
  nowMinute?: number | null;
  onEmptyClick?: (column: string, minute: number) => void;
  minColumnWidth?: number;
}) {
  const t = useTranslations("timetable");
  const height = (hours.endMinute - hours.startMinute) * PX_PER_MINUTE;
  const top = (minute: number) => (minute - hours.startMinute) * PX_PER_MINUTE;
  const hourMarks: number[] = [];
  for (let m = hours.startMinute; m < hours.endMinute; m += 60) {
    hourMarks.push(m);
  }

  // Roving focus: arrows move between blocks (↑/↓ by time within a column,
  // ←/→ to the nearest block of the neighbouring column).
  const ordered = columns.flatMap((column) =>
    items
      .filter((item) => item.column === column.key)
      .sort((a, b) => a.startMinute - b.startMinute),
  );
  const firstId = ordered[0]?.id;
  function onKeyDown(item: GridItem, event: KeyboardEvent<HTMLElement>) {
    const colIndex = columns.findIndex((c) => c.key === item.column);
    const inColumn = (key: string | undefined) =>
      ordered.filter((i) => i.column === key);
    let target: GridItem | undefined;
    const same = inColumn(item.column);
    const index = same.findIndex((i) => i.id === item.id);
    if (event.key === "ArrowDown") target = same[index + 1];
    else if (event.key === "ArrowUp") target = same[index - 1];
    else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const step = event.key === "ArrowRight" ? 1 : -1;
      for (
        let c = colIndex + step;
        c >= 0 && c < columns.length && !target;
        c += step
      ) {
        const candidates = inColumn(columns[c].key);
        target = [...candidates].sort(
          (a, b) =>
            Math.abs(a.startMinute - item.startMinute) -
            Math.abs(b.startMinute - item.startMinute),
        )[0];
      }
    } else return;
    event.preventDefault();
    if (!target) return;
    event.currentTarget
      .closest('[role="region"]')
      ?.querySelector<HTMLElement>(`[data-grid-item="${target.id}"]`)
      ?.focus();
  }

  return (
    <div
      role="region"
      aria-label={label}
      className="overflow-x-auto rounded-xl border bg-card"
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: `56px repeat(${columns.length}, minmax(${minColumnWidth}px, 1fr))`,
        }}
      >
        {/* Header row */}
        <div className="sticky left-0 z-20 border-b bg-card" />
        {columns.map((column) => (
          <div
            key={column.key}
            className={cn(
              "flex min-h-12 flex-col justify-center border-b border-l px-2 py-1",
              column.current && "bg-accent",
            )}
          >
            <h3
              className="truncate text-sm font-medium"
              aria-current={column.current ? "date" : undefined}
            >
              {column.title}
            </h3>
            {column.subtitle && (
              <span className="truncate text-xs text-muted-foreground">
                {column.subtitle}
              </span>
            )}
          </div>
        ))}

        {/* Time axis */}
        <div
          className="sticky left-0 z-10 bg-card"
          style={{ height }}
          aria-hidden="true"
        >
          {hourMarks.map((m) => (
            <div
              key={m}
              className="absolute right-2 -translate-y-1/2 text-xs text-muted-foreground tabular-nums"
              style={{ top: top(m) || 6 }}
            >
              {formatMinutes(m)}
            </div>
          ))}
        </div>

        {columns.map((column) => {
          const colItems = items.filter((i) => i.column === column.key);
          const { placed, overflow } = layoutColumn(colItems);
          const byId = new Map(colItems.map((i) => [i.id, i]));
          return (
            <div
              key={column.key}
              className={cn(
                "relative border-l",
                column.striped && "stripes",
                onEmptyClick && "cursor-cell",
              )}
              style={{
                height,
                backgroundImage: column.striped
                  ? undefined
                  : `repeating-linear-gradient(to bottom, transparent 0 ${30 * PX_PER_MINUTE - 1}px, var(--border) ${30 * PX_PER_MINUTE - 1}px ${30 * PX_PER_MINUTE}px)`,
              }}
              onClick={(event) => {
                if (!onEmptyClick || event.target !== event.currentTarget) {
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                const minute =
                  hours.startMinute +
                  (event.clientY - rect.top) / PX_PER_MINUTE;
                onEmptyClick(column.key, Math.floor(minute / SNAP) * SNAP);
              }}
            >
              {column.hatched?.map((range, i) => (
                <div
                  key={i}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 stripes"
                  style={{
                    top: top(Math.max(range.startMinute, hours.startMinute)),
                    height:
                      (Math.min(range.endMinute, hours.endMinute) -
                        Math.max(range.startMinute, hours.startMinute)) *
                      PX_PER_MINUTE,
                  }}
                />
              ))}
              {column.current && nowMinute != null && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-lesson-now"
                  style={{ top: top(nowMinute) }}
                />
              )}
              {placed.map(({ id, lane, lanes }) => {
                const item = byId.get(id)!;
                const blockHeight = Math.max(
                  (item.endMinute - item.startMinute) * PX_PER_MINUTE,
                  MIN_BLOCK_PX,
                );
                return (
                  <div key={id}>
                    {item.render({
                      style: {
                        position: "absolute",
                        top: top(item.startMinute),
                        height: blockHeight,
                        left: `calc(${(lane / lanes) * 100}% + 2px)`,
                        width: `calc(${100 / lanes}% - 4px)`,
                      },
                      compact: item.endMinute - item.startMinute <= 30,
                      tabIndex: id === firstId ? 0 : -1,
                      onKeyDown: (event) => onKeyDown(item, event),
                      "data-grid-item": id,
                    })}
                  </div>
                );
              })}
              {overflow.map((group) => (
                <Popover key={group.ids.join()}>
                  <PopoverTrigger
                    className="absolute flex items-start justify-center rounded-md border bg-muted px-1 py-0.5 text-xs font-medium hover:bg-accent"
                    style={{
                      top: top(group.startMinute),
                      height: Math.max(
                        (group.endMinute - group.startMinute) * PX_PER_MINUTE,
                        MIN_BLOCK_PX,
                      ),
                      left: `calc(${(group.lane / group.lanes) * 100}% + 2px)`,
                      width: `calc(${100 / group.lanes}% - 4px)`,
                    }}
                  >
                    {t("moreLessons", { count: group.ids.length })}
                  </PopoverTrigger>
                  <PopoverContent className="w-64 p-1">
                    <ul className="flex flex-col">
                      {group.ids.map((id) => {
                        const item = byId.get(id)!;
                        return (
                          <li key={id}>
                            <button
                              type="button"
                              className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                              onClick={item.onOverflowSelect}
                            >
                              {item.overflowLabel}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </PopoverContent>
                </Popover>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
