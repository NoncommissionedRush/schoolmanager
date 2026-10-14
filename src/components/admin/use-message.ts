"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

import type { Message, MessageValue } from "@/server/admin/result";

type RawTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/**
 * Renders a `Message` from a server action (an i18n key plus values, where a
 * value can itself be a message, e.g. a field label).
 */
export function useMessage() {
  const t = useTranslations() as unknown as RawTranslate;
  return useCallback(
    function render(message: Message): string {
      const values: Record<string, string | number> = {};
      for (const [name, value] of Object.entries(message.values ?? {})) {
        values[name] = resolve(value, render).toString();
      }
      return t(message.key, values);
    },
    [t],
  );
}

function resolve(
  value: MessageValue,
  render: (message: Message) => string,
): string | number {
  return typeof value === "object" ? render(value).toLowerCase() : value;
}
