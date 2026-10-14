import { describe, expect, it } from "vitest";

import { pageWindow, parseListParams, searchWhere, statusWhere } from "./list";

describe("list parameters", () => {
  it("defaults to active, page 1, no search", () => {
    expect(parseListParams({})).toEqual({ q: "", status: "active", page: 1 });
  });

  it("reads and sanitises the URL", () => {
    expect(
      parseListParams({ q: [" anna ", "x"], status: "archived", page: "3" }),
    ).toEqual({ q: "anna", status: "archived", page: 3 });
    expect(parseListParams({ status: "deleted", page: "-2" })).toMatchObject({
      status: "active",
      page: 1,
    });
  });

  it("maps the status filter to the soft-delete column", () => {
    expect(statusWhere("active", "deletedAt")).toEqual({ deletedAt: null });
    expect(statusWhere("archived", "archivedAt")).toEqual({
      archivedAt: { not: null },
    });
    expect(statusWhere("all", "deletedAt")).toEqual({});
  });

  it("pages 25 rows at a time and clamps to the last page", () => {
    expect(pageWindow(1, 132)).toEqual({
      page: 1,
      pages: 6,
      skip: 0,
      take: 25,
      from: 1,
      to: 25,
    });
    expect(pageWindow(9, 132)).toMatchObject({ page: 6, from: 126, to: 132 });
    expect(pageWindow(1, 0)).toMatchObject({
      page: 1,
      pages: 1,
      from: 0,
      to: 0,
    });
  });

  it("searches several (nested) columns case-insensitively", () => {
    expect(searchWhere("", ["name"])).toEqual({});
    expect(searchWhere("an", ["user.name", "phone"])).toEqual({
      OR: [
        { user: { name: { contains: "an", mode: "insensitive" } } },
        { phone: { contains: "an", mode: "insensitive" } },
      ],
    });
  });
});
