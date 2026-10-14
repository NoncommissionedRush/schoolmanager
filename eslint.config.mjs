import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

// Attributes whose text is shown or read out to users.
const LABEL_ATTRIBUTE =
  "JSXAttribute[name.name=/^(alt|title|placeholder|label|aria-label|aria-description|aria-placeholder|aria-valuetext)$/]";

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
      "react/jsx-no-literals": [
        "error",
        {
          noStrings: false,
          ignoreProps: true,
          // Punctuation that is the same in every language.
          allowedStrings: ["·", "–", "—", "/", "|", "×", "…", ":", "*"],
        },
      ],
      "no-restricted-syntax": [
        "error",
        ...[
          `${LABEL_ATTRIBUTE} > Literal`,
          `${LABEL_ATTRIBUTE} > JSXExpressionContainer > Literal`,
          `${LABEL_ATTRIBUTE} > JSXExpressionContainer > TemplateLiteral`,
        ].map((selector) => ({
          selector,
          message:
            "User-facing attribute text must come from next-intl (t('…')), not a string literal.",
        })),
        ...[
          ":matches(JSXElement, JSXFragment) > JSXExpressionContainer > Literal[value=/\\p{L}/u]",
          ":matches(JSXElement, JSXFragment) > JSXExpressionContainer > TemplateLiteral",
        ].map((selector) => ({
          selector,
          message:
            "User-facing text must come from next-intl (t('…')), not a string literal.",
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
