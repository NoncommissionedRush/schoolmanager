import { describe, expect, it } from "vitest";

import { toSchoolSlug } from "./schools";

describe("toSchoolSlug", () => {
  it("lowercases and hyphenates words", () => {
    expect(toSchoolSlug("Demo Language School")).toBe("demo-language-school");
  });

  it("strips diacritics and punctuation", () => {
    expect(toSchoolSlug("  Lingua Café, Bratislava! ")).toBe(
      "lingua-cafe-bratislava",
    );
  });
});
