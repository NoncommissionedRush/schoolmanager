# Design tokens

Visual foundation for the School Management System. Every value here maps to a
shadcn/ui CSS variable or a Tailwind theme key, so the app theme is a direct
copy of this file. Visual reference: `docs/design/wireframes/app-layout.html`
(tab **Tokens & components**).

Principles

- **Operational, calm, dense where it helps.** Admin and teacher screens are
  used all day on desktop; student screens are glanced at on a phone.
- **Neutral base + one brand color.** Color carries meaning (status, lesson
  type), never decoration. Meaning is never conveyed by color alone — always
  pair with a label, icon or pattern (WCAG 1.4.1).
- **WCAG 2.2 AA everywhere.** Body text ≥ 4.5:1, large text and UI boundaries
  ≥ 3:1, visible focus, targets ≥ 24×24 px (44×44 px on student mobile).

## 1. Color

Values are hex. With Tailwind v4 + current shadcn/ui the CSS variables hold full
colors, so hex can be used as-is (`--primary: #2563eb;`). If the scaffold ends
up on Tailwind v3, convert to the HSL-triplet format shadcn expects.

### 1.1 Semantic tokens — light mode (required)

| Token (`--…`)                            | Value     | Tailwind ref | Use                                                             | Contrast                       |
| ---------------------------------------- | --------- | ------------ | --------------------------------------------------------------- | ------------------------------ |
| `background`                             | `#ffffff` | white        | App canvas, cards on mobile                                     | —                              |
| `foreground`                             | `#0f172a` | slate-900    | Body text                                                       | 17.9:1 on white                |
| `card` / `popover`                       | `#ffffff` | white        | Cards, menus, dialogs                                           | —                              |
| `card-foreground` / `popover-foreground` | `#0f172a` | slate-900    |                                                                 | 17.9:1                         |
| `muted`                                  | `#f1f5f9` | slate-100    | Page background behind cards (desktop), table header, skeletons | —                              |
| `muted-foreground`                       | `#475569` | slate-600    | Secondary text, captions, placeholders                          | 7.6:1 on white, 6.9:1 on muted |
| `primary`                                | `#2563eb` | blue-600     | Primary buttons, links, active nav, focus ring                  | 5.2:1 on white                 |
| `primary-foreground`                     | `#ffffff` | white        | Text on primary                                                 | 5.2:1                          |
| `secondary`                              | `#f1f5f9` | slate-100    | Secondary buttons                                               | —                              |
| `secondary-foreground`                   | `#0f172a` | slate-900    |                                                                 | 16.3:1                         |
| `accent`                                 | `#eff6ff` | blue-50      | Hover/selected rows, active nav background                      | —                              |
| `accent-foreground`                      | `#1e40af` | blue-800     | Text on accent (active nav label)                               | 8.0:1                          |
| `destructive`                            | `#dc2626` | red-600      | Delete, errors                                                  | 4.8:1 on white                 |
| `destructive-foreground`                 | `#ffffff` | white        |                                                                 | 4.8:1                          |
| `border`                                 | `#e2e8f0` | slate-200    | Card/table dividers (decorative)                                | —                              |
| `input`                                  | `#64748b` | slate-500    | Form control borders (must be ≥ 3:1, WCAG 1.4.11)               | 4.8:1                          |
| `ring`                                   | `#2563eb` | blue-600     | Focus ring                                                      | 5.2:1                          |

Status tokens (extend the shadcn set; used by `Badge`, `Alert`, toasts). Every fg is ≥ 4.5:1 on both white and its own surface:

| Token     | Fg (text/icon)              | Bg (surface)       | Border              | Use                              |
| --------- | --------------------------- | ------------------ | ------------------- | -------------------------------- |
| `success` | `#15803d` green-700 (5.0:1) | `#f0fdf4` green-50 | `#86efac` green-300 | Saved, present, approved         |
| `warning` | `#b45309` amber-700 (5.0:1) | `#fffbeb` amber-50 | `#fcd34d` amber-300 | Pending review, late, overridden |
| `info`    | `#1d4ed8` blue-700 (6.7:1)  | `#eff6ff` blue-50  | `#93c5fd` blue-300  | Neutral notices                  |
| `danger`  | `#b91c1c` red-700 (6.5:1)   | `#fef2f2` red-50   | `#fca5a5` red-300   | Errors, absent, cancelled        |

### 1.2 Domain tokens — timetable & lessons

Lesson blocks use a tinted surface, a 3 px left border and dark text. The
**type label/icon is always shown** — color only reinforces it.

| Token                | Surface             | Left border                                   | Text                                                                          | Icon (lucide)    | Meaning                                                            | Phase |
| -------------------- | ------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------ | ----- |
| `lesson-group`       | `#eff6ff` blue-50   | `#2563eb` blue-600                            | `#1e3a8a` blue-900                                                            | `users`          | Group lesson                                                       | P1    |
| `lesson-individual`  | `#f5f3ff` violet-50 | `#7c3aed` violet-600                          | `#4c1d95` violet-900                                                          | `user`           | 1-on-1 lesson                                                      | P1    |
| `lesson-replacement` | `#fffbeb` amber-50  | `#d97706` amber-600                           | `#78350f` amber-900                                                           | `repeat`         | Student attends as a replacement                                   | P3    |
| `lesson-substitute`  | `#ecfeff` cyan-50   | `#0891b2` cyan-600                            | `#164e63` cyan-900                                                            | `user-round-cog` | Substitute teacher                                                 | P5    |
| `lesson-cancelled`   | `#f8fafc` slate-50  | `#94a3b8` slate-400, dashed                   | `#475569` slate-600, line-through                                             | `ban`            | Cancelled lesson                                                   | P2    |
| `internal`           | `#f8fafc` slate-50  | `#475569` slate-600, dashed (1 px, all sides) | `#0f172a` slate-900; header band `#1e293b` slate-800 with white text (14.6:1) | `lock`           | Internal TeacherNotes — teachers and admins only (`lessons.md` §4) | P2    |
| `lesson-now`         | —                   | —                                             | —                                                                             | —                | Current-time line: 2 px `#dc2626` red-600 across today's column    | P1    |

All text/surface pairs above are ≥ 7:1.

### 1.3 Dark mode

Added 2026-10-27 (CARM-88; replaces the 2026-10-14 "light only" decision).
`next-themes` with the `class` strategy; the default follows the OS setting and
users pick Light / Dark / System in the account menu (stored per browser). The
full token set lives in the `.dark` block of `src/app/globals.css`;
status/lesson tokens swap to `-300`/`-200` text on `-950` surfaces.

| Token                    | Value               | Token         | Value               |
| ------------------------ | ------------------- | ------------- | ------------------- |
| `background`             | `#020617` slate-950 | `foreground`  | `#f8fafc` slate-50  |
| `card` / `popover`       | `#0f172a` slate-900 | `muted`       | `#1e293b` slate-800 |
| `muted-foreground`       | `#94a3b8` slate-400 | `primary`     | `#60a5fa` blue-400  |
| `primary-foreground`     | `#0f172a` slate-900 | `accent`      | `#172554` blue-950  |
| `accent-foreground`      | `#bfdbfe` blue-200  | `destructive` | `#f87171` red-400   |
| `destructive-foreground` | `#0f172a`           | `border`      | `#1e293b` slate-800 |
| `input`                  | `#64748b` slate-500 | `ring`        | `#60a5fa` blue-400  |

## 2. Typography

- **Family:** Inter via `next/font/google` (`--font-sans`), fallback
  `ui-sans-serif, system-ui, sans-serif`. Monospace not needed in v1.
- **Numerals:** `tabular-nums` on times, dates, tables and the timetable grid.
- **Base size:** 14 px on admin/teacher desktop screens (dense), 16 px on
  student mobile screens and **all form inputs on mobile** (prevents iOS zoom).
- Text must reflow at 400 % zoom / 320 px width (WCAG 1.4.10); never fix heights on text containers.

| Role               | Tailwind    | Size / line-height | Weight  | Use                               |
| ------------------ | ----------- | ------------------ | ------- | --------------------------------- |
| Display            | `text-3xl`  | 30 / 36            | 600     | Login school name only            |
| Page title (h1)    | `text-2xl`  | 24 / 32            | 600     | One per page                      |
| Section title (h2) | `text-lg`   | 18 / 28            | 600     | Card titles, dialog titles        |
| Subsection (h3)    | `text-base` | 16 / 24            | 600     | Group headings in forms           |
| Body (desktop)     | `text-sm`   | 14 / 20            | 400     | Tables, forms, most UI            |
| Body (mobile)      | `text-base` | 16 / 24            | 400     | Student views                     |
| Label              | `text-sm`   | 14 / 20            | 500     | Form labels, nav items            |
| Caption            | `text-xs`   | 12 / 16            | 400–500 | Meta text, badges, grid time axis |

Minimum text size is 12 px; never below.

## 3. Spacing

Tailwind's 4 px scale. Use only these steps for layout: `1 2 3 4 6 8 12 16`
(4–64 px).

| Use                               | Value                                                               |
| --------------------------------- | ------------------------------------------------------------------- |
| Page padding                      | `p-4` (16) mobile · `p-6` (24) ≥ md                                 |
| Gap between page sections / cards | `gap-6` (24) desktop · `gap-4` (16) mobile                          |
| Card padding                      | `p-4` mobile · `p-6` desktop                                        |
| Form field vertical rhythm        | `space-y-4` between fields, `space-y-2` label→control               |
| Table cell                        | `px-3 py-2` (dense)                                                 |
| Inline icon + text                | `gap-2`                                                             |
| Max content width                 | `max-w-screen-2xl` for data screens; `max-w-2xl` for forms/settings |

Layout dimensions

| Element                | Value                                                    |
| ---------------------- | -------------------------------------------------------- |
| Header height          | 56 px (`h-14`)                                           |
| Sidebar                | 256 px expanded (`w-64`) · 56 px icon rail collapsed     |
| Student bottom tab bar | 64 px + `env(safe-area-inset-bottom)`                    |
| Control height         | 36 px (`h-9`) desktop · 44 px (`h-11`) on student mobile |
| Timetable hour row     | 64 px (`h-16`) desktop week · agenda list on mobile      |

## 4. Radius

`--radius: 0.5rem` (8 px). shadcn derives the rest:

| Token          | Value | Use                                     |
| -------------- | ----- | --------------------------------------- |
| `rounded-sm`   | 4 px  | Badges, checkboxes, lesson blocks       |
| `rounded-md`   | 6 px  | Buttons, inputs, menu items             |
| `rounded-lg`   | 8 px  | Cards, popovers, dialogs                |
| `rounded-xl`   | 12 px | Login card, mobile sheets (top corners) |
| `rounded-full` | —     | Avatars, status dots                    |

## 5. Elevation

Prefer borders over shadows. Only three levels:

| Level | Tailwind      | Use                                                 |
| ----- | ------------- | --------------------------------------------------- |
| 0     | `border` only | Cards, tables, sidebar                              |
| 1     | `shadow-sm`   | Sticky header on scroll, lesson block on hover/drag |
| 2     | `shadow-lg`   | Popover, dropdown, dialog, sheet, toast             |

Dialog/sheet overlay: `bg-black/50`.

## 6. Breakpoints

Tailwind defaults: `sm 640 · md 768 · lg 1024 · xl 1280 · 2xl 1536`.

| Range    | Layout                                                             |
| -------- | ------------------------------------------------------------------ |
| < 768    | Mobile: header + sheet nav; student gets bottom tab bar            |
| 768–1023 | Tablet: sidebar collapsed to icon rail by default                  |
| ≥ 1024   | Desktop: sidebar expanded (user can collapse; persisted in cookie) |

## 7. Motion

- Durations 150 ms (hover, color) and 200 ms (sheet/dialog). Easing `ease-out`.
- Respect `prefers-reduced-motion`: disable transforms/slide-ins, keep opacity fades.
- No skeleton shimmer under reduced motion (static `bg-muted`).

## 8. Focus, targets, accessibility defaults

- Focus: `focus-visible:ring-2 ring-ring ring-offset-2 ring-offset-background`.
  Never remove the outline without this replacement. Focused element must not
  be hidden by the sticky header or bottom bar (WCAG 2.4.11) — use
  `scroll-padding-top: 4rem` / `scroll-padding-bottom: 5rem`.
- Targets ≥ 24×24 px (WCAG 2.5.8); student mobile ≥ 44×44 px.
- Icons-only buttons always have `aria-label` (from i18n) and a `Tooltip`.
- Every page has one `h1`, a "Skip to content" link as the first focusable
  element, and landmark regions (`header`, `nav`, `main`).
- Dragging (timetable editor, later) must have a non-drag alternative (WCAG 2.5.7).

## 9. Theme mapping (implementation sketch)

```css
/* app/globals.css — light */
:root {
  --radius: 0.5rem;
  --background: #ffffff;
  --foreground: #0f172a;
  --card: #ffffff;
  --card-foreground: #0f172a;
  --popover: #ffffff;
  --popover-foreground: #0f172a;
  --primary: #2563eb;
  --primary-foreground: #ffffff;
  --secondary: #f1f5f9;
  --secondary-foreground: #0f172a;
  --muted: #f1f5f9;
  --muted-foreground: #475569;
  --accent: #eff6ff;
  --accent-foreground: #1e40af;
  --destructive: #dc2626;
  --destructive-foreground: #ffffff;
  --border: #e2e8f0;
  --input: #64748b;
  --ring: #2563eb;

  --success: #15803d;
  --success-surface: #f0fdf4;
  --warning: #b45309;
  --warning-surface: #fffbeb;
  --info: #1d4ed8;
  --info-surface: #eff6ff;

  --lesson-group: #2563eb;
  --lesson-group-surface: #eff6ff;
  --lesson-group-text: #1e3a8a;
  --lesson-individual: #7c3aed;
  --lesson-individual-surface: #f5f3ff;
  --lesson-individual-text: #4c1d95;
  --lesson-replacement: #d97706;
  --lesson-replacement-surface: #fffbeb;
  --lesson-replacement-text: #78350f;
  --internal: #475569;
  --internal-surface: #f8fafc;
  --internal-band: #1e293b;

  /* shadcn Sidebar */
  --sidebar: #ffffff;
  --sidebar-foreground: #0f172a;
  --sidebar-accent: #eff6ff;
  --sidebar-accent-foreground: #1e40af;
  --sidebar-border: #e2e8f0;
  --sidebar-ring: #2563eb;
}
```

Expose the custom tokens through `@theme inline { --color-success: var(--success); … }`
so `text-success`, `bg-lesson-group-surface` etc. work as utilities.
