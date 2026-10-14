import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

// Attributes whose text is shown or read out to users.
const LABEL_ATTRIBUTE =
  "JSXAttribute[name.name=/^(alt|title|placeholder|label|aria-label|aria-description|aria-placeholder|aria-valuetext)$/]";
// Text rendered as an element's child.
const CHILD = ":matches(JSXElement, JSXFragment) > JSXExpressionContainer";
// `ok ? "Yes" : "No"`, `ok && "Shown"`, `name ?? "Unknown"`, one level nested.
const BRANCH = ":matches(ConditionalExpression, LogicalExpression)";
const TEXT = ":matches(Literal[value=/\\p{L}/u], TemplateLiteral)";
const I18N_HINT =
  "Use a message from next-intl, e.g. {t('key')} (see docs/architecture/i18n.md). Wrapping the text in {\"…\"} doesn't help — that is rejected too.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    // Guard against hard-coded user-facing strings: UI copy goes through
    // next-intl (see docs/architecture/i18n.md).
    files: ["src/**/*.tsx"],
    ignores: ["src/**/*.test.tsx", "src/components/ui/**"],
    rules: {
      // JSX text is checked by the `JSXText` selector below instead of
      // `react/jsx-no-literals`, whose "Missing JSX expression container"
      // message suggested wrapping the text in {"…"} (QA note on PR #3).
      // Text without letters (punctuation such as "·" or "–") is allowed.
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXText[value=/\\p{L}/u]",
          message: `Hard-coded UI text. ${I18N_HINT}`,
        },
        ...[
          `${LABEL_ATTRIBUTE} > Literal`,
          `${LABEL_ATTRIBUTE} > JSXExpressionContainer > Literal`,
          `${LABEL_ATTRIBUTE} > JSXExpressionContainer > TemplateLiteral`,
          `${LABEL_ATTRIBUTE} > JSXExpressionContainer > ${BRANCH} > ${TEXT}`,
          `${LABEL_ATTRIBUTE} > JSXExpressionContainer > ${BRANCH} > ${BRANCH} > ${TEXT}`,
        ].map((selector) => ({
          selector,
          message: `Hard-coded text in a user-facing attribute. ${I18N_HINT}`,
        })),
        ...[
          `${CHILD} > Literal[value=/\\p{L}/u]`,
          `${CHILD} > TemplateLiteral`,
          `${CHILD} > ${BRANCH} > ${TEXT}`,
          `${CHILD} > ${BRANCH} > ${BRANCH} > ${TEXT}`,
        ].map((selector) => ({
          selector,
          message: `Hard-coded UI text in a JSX expression. ${I18N_HINT}`,
        })),
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
