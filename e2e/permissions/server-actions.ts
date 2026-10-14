import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

// Calls a server action directly, the way a crafted request would — not
// through the UI, which may hide the button. Lets permission specs prove the
// action itself refuses, whatever the page shows.

type Manifest = {
  node: Record<
    string,
    {
      filename?: string;
      exportedName?: string;
      workers: Record<string, unknown>;
    }
  >;
};

export type ServerAction = {
  id: string;
  /** A page that bundles the action: Next only runs it when posted there. */
  route: string;
};

// `pnpm build` writes the manifest to .next/server; `pnpm dev` to
// .next/dev/server, and only for pages it has compiled so far.
const MANIFESTS = [".next/server", ".next/dev/server"].map((dir) =>
  path.join(process.cwd(), dir, "server-reference-manifest.json"),
);

/**
 * `app/admin/settings/rooms/page` → `/admin/settings/rooms`. Dynamic
 * segments get a placeholder: the action runs before the page renders.
 */
function workerRoute(worker: string): string | null {
  const match = /^app(.*)\/page$/.exec(worker);
  if (!match) return null;
  return match[1].replace(/\[[^\]]+\]/g, PLACEHOLDER_ID) || "/";
}

const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

/** Every server action the app exposes, keyed `file#export`. */
export function serverActions(): Map<string, ServerAction> {
  const actions = new Map<string, ServerAction>();
  for (const file of MANIFESTS) {
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    for (const [id, entry] of Object.entries(manifest.node)) {
      // Prefer a static page; fall back to a dynamic one.
      const routes = Object.keys(entry.workers)
        .map(workerRoute)
        .filter((r) => r !== null)
        .sort(
          (a, b) =>
            Number(a.includes(PLACEHOLDER_ID)) -
            Number(b.includes(PLACEHOLDER_ID)),
        );
      const route = routes[0];
      if (entry.filename && entry.exportedName && route) {
        actions.set(`${entry.filename}#${entry.exportedName}`, { id, route });
      }
    }
    if (actions.size > 0) break;
  }
  return actions;
}

export function findAction(file: string, name: string): ServerAction {
  const action = serverActions().get(`${file}#${name}`);
  if (!action) {
    throw new Error(
      `Server action ${file}#${name} not found in the manifest. ` +
        "Build the app (`pnpm build`) or open a page that uses it first.",
    );
  }
  return action;
}

export type ActionResponse = {
  status: number;
  /** The action's return value (`ActionResult`), when it returned one. */
  result: { ok: boolean; [key: string]: unknown } | null;
  body: string;
};

/**
 * Encodes `args` like React's `encodeReply`: plain JSON, or — when an
 * argument is a form — multipart with the form's fields under `_<n>_`.
 */
function encodeArgs(args: unknown[]) {
  const forms: Record<string, string>[] = [];
  const json = JSON.stringify(args, (_key, value) => {
    if (value === undefined) return "$undefined";
    if (value instanceof FormFields) {
      forms.push(value.fields);
      return `$K${forms.length.toString(16)}`;
    }
    return value;
  });
  if (forms.length === 0) return { data: json };
  // The root ("0") goes last, like React sends it: the server decodes it as
  // soon as it arrives and only sees form fields that came before.
  const multipart = new FormData();
  forms.forEach((fields, i) => {
    for (const [key, value] of Object.entries(fields)) {
      multipart.append(`_${i + 1}_${key}`, value);
    }
  });
  multipart.append("0", json);
  return { multipart };
}

/** A `FormData` argument for `callAction`. */
export class FormFields {
  constructor(readonly fields: Record<string, string>) {}
}

/**
 * POSTs a server action as the user signed in on `page` (its cookies) to a
 * page that bundles it, and parses the RSC reply.
 */
export async function callAction(
  page: Page,
  [file, name]: readonly [string, string],
  args: unknown[],
): Promise<ActionResponse> {
  const action = findAction(file, name);
  const response = await page.request.post(action.route, {
    headers: {
      "Next-Action": action.id,
      Accept: "text/x-component",
      ...(args.some((a) => a instanceof FormFields)
        ? {}
        : { "Content-Type": "text/plain;charset=UTF-8" }),
    },
    ...encodeArgs(args),
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  const body = await response.text();
  return { status: response.status(), result: parseResult(body), body };
}

/** The action's return value: the RSC row the root row's `a` points at. */
function parseResult(body: string): ActionResponse["result"] {
  const rows = new Map<string, string>();
  for (const line of body.split("\n")) {
    const match = /^([0-9a-f]+):(.*)$/.exec(line);
    if (match) rows.set(match[1], match[2]);
  }
  try {
    const root = JSON.parse(rows.get("0") ?? "null") as { a?: unknown } | null;
    let value = root?.a;
    if (typeof value === "string" && value.startsWith("$@")) {
      value = JSON.parse(rows.get(value.slice(2)) ?? "null");
    }
    return value && typeof value === "object"
      ? (value as ActionResponse["result"])
      : null;
  } catch {
    return null;
  }
}
