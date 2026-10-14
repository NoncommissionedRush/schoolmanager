import { describe, expect, it } from "vitest";

import { firstName, initials, partOfDay } from "./greeting";

describe("partOfDay", () => {
  it.each([
    ["2026-10-14T05:30:00Z", "morning"], // 07:30 in Bratislava
    ["2026-10-14T10:30:00Z", "afternoon"], // 12:30
    ["2026-10-14T16:30:00Z", "evening"], // 18:30
    ["2026-10-14T01:00:00Z", "evening"], // 03:00
  ])("%s → %s in Europe/Bratislava", (iso, expected) => {
    expect(partOfDay(new Date(iso), "Europe/Bratislava")).toBe(expected);
  });

  it("uses the school's time zone, not the server's", () => {
    const instant = new Date("2026-10-14T10:30:00Z");
    expect(partOfDay(instant, "America/New_York")).toBe("morning");
  });
});

describe("names", () => {
  it("takes the first name", () => {
    expect(firstName("  Jana Nováková ")).toBe("Jana");
  });

  it("builds up to two initials", () => {
    expect(initials("Demo Language School")).toBe("DL");
    expect(initials("Ľubica")).toBe("Ľ");
  });
});
