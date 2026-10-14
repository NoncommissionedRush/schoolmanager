import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// The i18n lint guard in eslint.config.mjs: hard-coded UI text in JSX must
// fail `pnpm lint` with a message that points to next-intl.
describe("i18n lint guard", () => {
  let eslint: ESLint;
  beforeAll(() => {
    eslint = new ESLint({ cwd: process.cwd() });
  });

  async function lint(jsx: string) {
    const source = `export function C({ ok, name, t }: { ok: boolean; name?: string; t: (k: string) => string }) {\n  return ${jsx};\n}\n`;
    const [result] = await eslint.lintText(source, {
      filePath: "src/app/lint-guard-fixture.tsx",
    });
    return result.messages
      .filter((m) => m.ruleId === "no-restricted-syntax")
      .map((m) => m.message);
  }

  it.each([
    ["JSX text", "<p>Hello</p>"],
    ["a string child", '<p>{"Hello"}</p>'],
    ["a template child", "<p>{`Hello ${name}`}</p>"],
    ["a ternary child", '<p>{ok ? "Yes" : "No"}</p>'],
    ["a && child", '<p>{ok && "Shown"}</p>'],
    ["a ?? child", '<p>{name ?? "Unknown"}</p>'],
    ["a nested ternary", '<p>{ok ? t("a") : name ? "Named" : t("b")}</p>'],
    ["a label attribute", '<input aria-label="Search" />'],
    ["a conditional label", '<input placeholder={ok ? "Yes" : t("no")} />'],
  ])("rejects %s", async (_, jsx) => {
    const messages = await lint(jsx);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toMatch(/next-intl/);
    expect(messages[0]).toMatch(/\{t\('key'\)\}/);
  });

  it.each([
    ["translated text", '<p>{t("hello")}</p>'],
    ["a translated ternary", '<p>{ok ? t("yes") : t("no")}</p>'],
    ["punctuation", "<p>{name} · {name} – {name}</p>"],
    ["class names", '<p className={ok ? "font-bold" : "italic"}>{name}</p>'],
    ["conditional elements", "<p>{ok && <span>{name}</span>}</p>"],
  ])("allows %s", async (_, jsx) => {
    expect(await lint(jsx)).toEqual([]);
  });
});
