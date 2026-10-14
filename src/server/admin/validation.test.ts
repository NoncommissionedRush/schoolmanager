import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  email,
  formDataToObject,
  id,
  integer,
  isoDate,
  list,
  optionalHttpsUrl,
  optionalText,
  parseInput,
  password,
  requiredText,
  timeOfDay,
} from "./validation";

const errorsOf = (schema: z.ZodType, input: unknown) => {
  const result = parseInput(schema, input);
  return result.ok ? null : result.fieldErrors;
};

describe("admin validation building blocks", () => {
  it("trims required text and reports empty / too short / too long", () => {
    const schema = z.object({ name: requiredText({ min: 2, max: 5 }) });
    expect(parseInput(schema, { name: "  Ann " })).toEqual({
      ok: true,
      data: { name: "Ann" },
    });
    expect(errorsOf(schema, { name: "  " })).toEqual({
      name: { key: "validation.requiredField" },
    });
    expect(errorsOf(schema, {})).toEqual({
      name: { key: "validation.requiredField" },
    });
    expect(errorsOf(schema, { name: "A" })).toEqual({
      name: { key: "validation.minLength", values: { min: 2 } },
    });
    expect(errorsOf(schema, { name: "Annabel" })).toEqual({
      name: { key: "validation.maxLength", values: { max: 5 } },
    });
  });

  it("turns empty optional text into null", () => {
    const schema = z.object({ note: optionalText({ max: 3 }) });
    expect(parseInput(schema, { note: " " })).toEqual({
      ok: true,
      data: { note: null },
    });
    expect(errorsOf(schema, { note: "long" })?.note.key).toBe(
      "validation.maxLength",
    );
  });

  it("lower-cases emails (§9) and rejects invalid ones", () => {
    const schema = z.object({ email: email() });
    expect(parseInput(schema, { email: " Anna@X.sk " })).toEqual({
      ok: true,
      data: { email: "anna@x.sk" },
    });
    expect(errorsOf(schema, { email: "anna@" })?.email.key).toBe(
      "validation.email",
    );
  });

  it("requires passwords of at least 10 characters, untrimmed", () => {
    const schema = z.object({ password: password() });
    expect(errorsOf(schema, { password: "123456789" })).toEqual({
      password: { key: "validation.passwordMin" },
    });
    expect(parseInput(schema, { password: " 123456789" }).ok).toBe(true);
  });

  it("parses whole numbers in a range", () => {
    const required = z.object({ n: integer({ min: 1, max: 500 }) });
    const optional = z.object({
      n: integer({ min: 1, max: 500, optional: true }),
    });
    const range = {
      key: "validation.integerRange",
      values: { min: 1, max: 500 },
    };
    expect(parseInput(required, { n: "12" })).toEqual({
      ok: true,
      data: { n: 12 },
    });
    expect(errorsOf(required, { n: "" })).toEqual({ n: range });
    expect(errorsOf(required, { n: "1.5" })).toEqual({ n: range });
    expect(errorsOf(required, { n: "501" })).toEqual({ n: range });
    expect(errorsOf(required, { n: "abc" })).toEqual({ n: range });
    expect(parseInput(optional, { n: "" })).toEqual({
      ok: true,
      data: { n: null },
    });
  });

  it("names the field in picker errors", () => {
    const schema = z.object({ levelId: id("groups.field.level") });
    expect(errorsOf(schema, { levelId: "" })).toEqual({
      levelId: {
        key: "validation.select",
        values: { field: { key: "groups.field.level" } },
      },
    });
    expect(
      parseInput(schema, { levelId: "0b6c7f3e-1d1a-4c55-9a43-8a1f4e1c2b3d" })
        .ok,
    ).toBe(true);
  });

  it("only accepts https links", () => {
    const schema = z.object({ url: optionalHttpsUrl() });
    expect(parseInput(schema, { url: "" })).toEqual({
      ok: true,
      data: { url: null },
    });
    expect(parseInput(schema, { url: "https://meet.example.com/x" }).ok).toBe(
      true,
    );
    for (const url of [
      "http://meet.example.com",
      "javascript:alert(1)",
      "meet",
    ]) {
      expect(errorsOf(schema, { url })?.url.key).toBe("validation.url");
    }
  });

  it("validates calendar dates and times of day", () => {
    const schema = z.object({ date: isoDate(), time: timeOfDay() });
    expect(parseInput(schema, { date: "2026-10-14", time: "09:30" })).toEqual({
      ok: true,
      data: { date: "2026-10-14", time: 570 },
    });
    expect(errorsOf(schema, { date: "2026-02-30", time: "24:00" })).toEqual({
      date: { key: "validation.date" },
      time: { key: "validation.time" },
    });
  });

  it("reads repeated form fields as lists", () => {
    const formData = new FormData();
    formData.append("weekday", "1");
    formData.append("weekday", "3");
    formData.append("name", "Ann");
    formData.append("$ACTION_ID_abc", "");
    expect(formDataToObject(formData)).toEqual({
      weekday: ["1", "3"],
      name: "Ann",
    });
    const schema = z.object({ weekday: list(z.coerce.number()) });
    expect(parseInput(schema, { weekday: "2" })).toEqual({
      ok: true,
      data: { weekday: [2] },
    });
    expect(parseInput(schema, {})).toEqual({ ok: true, data: { weekday: [] } });
  });
});
