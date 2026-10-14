"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

import type { Message } from "@/server/admin/result";

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
      // Field labels inside validation messages read mid-sentence
      // ("Choose level."), so they are lower-cased there.
      const lower = message.key.startsWith("validation.");
      for (const [name, value] of Object.entries(message.values ?? {})) {
        values[name] =
          typeof value === "object"
            ? lower
              ? render(value).toLowerCase()
              : render(value)
            : value;
      }
      return t(message.key, values);
    },
    [t],
  );
}
