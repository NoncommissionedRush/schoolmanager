import { z } from "zod";

import {
  email,
  optionalId,
  optionalText,
  password,
  requiredText,
} from "../validation";

/** Fields every person has (§6.2, §6.6, §6.12). */
export const personFields = {
  name: requiredText({ min: 2, max: 100 }),
  email: email(),
};

/** Set / reset password dialog (§5.4). */
export const setPasswordSchema = z.object({ password: password() });

/** Teacher timetable colours (§6.2): fixed palette, ≥ 3:1 on white. */
export const TEACHER_COLORS = {
  blue: "#2563eb",
  teal: "#0d9488",
  green: "#16a34a",
  orange: "#ea580c",
  rose: "#e11d48",
  purple: "#7c3aed",
  slate: "#475569",
  amber: "#b45309",
} as const;

export type TeacherColor = keyof typeof TEACHER_COLORS;

const colorField = z.preprocess(
  (value) => (value === "" || value === undefined ? null : value),
  z
    .enum(Object.keys(TEACHER_COLORS) as [TeacherColor, ...TeacherColor[]])
    .nullable(),
);

export const createTeacherSchema = z.object({
  ...personFields,
  password: password(),
  color: colorField,
});

export const updateTeacherSchema = z.object({
  ...personFields,
  color: colorField,
  bio: optionalText({ max: 1000 }),
  updatedAt: z.string().optional(),
});

export const createStudentSchema = z.object({
  ...personFields,
  password: password(),
  levelId: optionalId(),
  phone: optionalText({ max: 30 }),
  groupId: optionalId(),
});

export const updateStudentSchema = z.object({
  ...personFields,
  levelId: optionalId(),
  phone: optionalText({ max: 30 }),
  updatedAt: z.string().optional(),
});

export const createAdminSchema = z.object({
  ...personFields,
  password: password(),
});

export type CreateTeacherInput = z.output<typeof createTeacherSchema>;
export type UpdateTeacherInput = z.output<typeof updateTeacherSchema>;
export type CreateStudentInput = z.output<typeof createStudentSchema>;
export type UpdateStudentInput = z.output<typeof updateStudentSchema>;
export type CreateAdminInput = z.output<typeof createAdminSchema>;

/** Stored hex → palette name (seeded teachers may use other hex values). */
export function colorName(hex: string | null | undefined): TeacherColor | null {
  if (!hex) return null;
  const entry = Object.entries(TEACHER_COLORS).find(
    ([, value]) => value.toLowerCase() === hex.toLowerCase(),
  );
  return (entry?.[0] as TeacherColor | undefined) ?? null;
}

/** Default colour for a new teacher: the first swatch nobody uses yet. */
export function nextUnusedColor(used: (string | null)[]): TeacherColor {
  const taken = new Set(used.map((hex) => hex?.toLowerCase()));
  const names = Object.keys(TEACHER_COLORS) as TeacherColor[];
  return (
    names.find((name) => !taken.has(TEACHER_COLORS[name])) ??
    names[used.length % names.length]
  );
}
