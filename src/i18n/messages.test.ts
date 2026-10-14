import { createTranslator, IntlErrorCode } from "next-intl";
import { describe, expect, it } from "vitest";
import { locales } from "./config";
import { loadMessages } from "./messages";

type Catalog = { [key: string]: string | Catalog };

function keysOf(catalog: Catalog, prefix = ""): string[] {
  return Object.entries(catalog).flatMap(([key, value]) =>
    typeof value === "string"
      ? [`${prefix}${key}`]
      : keysOf(value, `${prefix}${key}.`),
  );
}

describe("message catalogs", async () => {
  const catalogs = await Promise.all(
    locales.map(async (locale) => ({
      locale,
      messages: (await loadMessages(locale)) as Catalog,
    })),
  );
  const reference = keysOf(catalogs[0].messages).sort();

  it.each(catalogs)(
    "$locale has the same keys as the default catalog",
    ({ messages }) => {
      expect(keysOf(messages).sort()).toEqual(reference);
    },
  );

  it.each(catalogs)(
    "$locale only contains valid ICU messages",
    ({ locale, messages }) => {
      const invalid: string[] = [];
      const t = createTranslator({
        locale,
        messages,
        onError: (error) => {
          // Missing arguments are expected here; syntax errors are not.
          if (error.code === IntlErrorCode.INVALID_MESSAGE)
            invalid.push(error.message);
        },
      });
      for (const key of keysOf(messages)) {
        (t as unknown as (key: string) => string)(key);
      }
      expect(invalid).toEqual([]);
    },
  );
});
