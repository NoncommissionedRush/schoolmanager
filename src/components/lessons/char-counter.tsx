"use client";

import { useTranslations } from "next-intl";

import { counterFrom } from "@/server/lessons/rules";

/**
 * Character counter shown from 90 % of the limit (lessons.md §5.2, §9);
 * announced politely only while it is visible.
 */
export function CharCounter({
  id,
  count,
  max,
}: {
  id: string;
  count: number;
  max: number;
}) {
  const t = useTranslations("lessonLog");
  const visible = count >= counterFrom(max);
  return (
    <p
      id={id}
      aria-live={visible ? "polite" : undefined}
      className={
        count > max
          ? "text-xs text-destructive tabular-nums"
          : "text-xs text-muted-foreground tabular-nums"
      }
    >
      {visible ? t("counter", { count, max }) : null}
    </p>
  );
}
