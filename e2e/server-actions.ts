import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  type APIRequestContext,
  type APIResponse,
  type Page,
  test,
} from "@playwright/test";

/**
 * Calls Next.js server actions over HTTP, the way a hostile client would:
 * a POST with the action's id in `Next-Action`, whatever the UI shows.
 *
 * Action ids are build-specific hashes. They are read from the server
 * reference manifest Next writes next to the build — `.next/dev` for
 * `pnpm dev`, `.next` for `pnpm start` (CI). In dev, routes compile on first
 * request, so visit the pages owning the actions before resolving them.
 */

type ManifestEntry = {
  exportedName?: string;
  filename?: string;
  workers: Record<string, unknown>;
};

function manifestPath() {
  const dev = ".next/dev/server/server-reference-manifest.json";
  const prod = ".next/server/server-reference-manifest.json";
  const candidates = process.env.CI ? [prod, dev] : [dev, prod];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("No server reference manifest; is Next running?");
  return found;
}

/** Stands in for dynamic segments (`[id]`) in page paths. */
export const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

/** Route of a worker (`app/admin/levels/page` → `/admin/levels`). */
const workerPath = (worker: string) =>
  `/${worker.slice("app/".length, -"/page".length)}`.replace(
    /\[[^\]]+\]/g,
    PLACEHOLDER_ID,
  );

export type ServerAction = { id: string; path: string };

/**
 * Every compiled server action by `filename#exportedName`: its id and the
 * path of a page that serves it — one in the action's own area
 * (`src/app/student/…` → `app/student/…`) first, then static pages. A page
 * of another area may list the action without serving it (Next answers
 * 409 "failed to find Server Action"), which would hide the real refusal.
 */
export function compiledServerActions(): Map<string, ServerAction> {
  const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as {
    node: Record<string, ManifestEntry>;
  };
  const actions = new Map<string, ServerAction>();
  for (const [id, entry] of Object.entries(manifest.node)) {
    const area = /^src\/(app\/[^/]+\/)/.exec(entry.filename ?? "")?.[1];
    const rank = (worker: string) =>
      (area && worker.startsWith(area) ? 0 : 2) + Number(worker.includes("["));
    const pages = Object.keys(entry.workers)
      .filter((worker) => worker.endsWith("/page"))
      .sort((a, b) => rank(a) - rank(b));
    if (!entry.filename || !entry.exportedName || !pages.length) continue;
    actions.set(`${entry.filename}#${entry.exportedName}`, {
      id,
      path: workerPath(pages[0]),
    });
  }
  return actions;
}

/**
 * Page URLs under `dir` (e.g. `src/app/admin`), dynamic segments filled with
 * a placeholder id. In dev, request them once so their actions compile.
 */
export function pagesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const child = join(dir, name);
    if (statSync(child).isDirectory()) return pagesIn(child);
    if (name !== "page.tsx") return [];
    const route = relative("src/app", dir).replace(
      /\[[^\]]+\]/g,
      PLACEHOLDER_ID,
    );
    return [`/${route}`];
  });
}

/**
 * Every exported function of the `"use server"` modules under `dir`, as
 * `filename#name` keys matching `serverActionIds()`.
 */
export function serverActionsIn(dir: string): string[] {
  const keys: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (statSync(child).isDirectory()) walk(child);
      else if (/\.tsx?$/.test(name)) {
        const source = readFileSync(child, "utf8");
        if (!/^\s*["']use server["']/.test(source)) continue;
        for (const match of source.matchAll(
          /export\s+async\s+function\s+(\w+)/g,
        )) {
          keys.push(`${child}#${match[1]}`);
        }
      }
    }
  };
  walk(dir);
  return keys.sort();
}

/**
 * A `FormData` argument: its fields, repeated keys as arrays. Every other
 * argument is sent as JSON.
 */
export class FormFields {
  constructor(readonly fields: Record<string, string | string[]>) {}
}

/**
 * Posts a server action call to `path` with the request's cookies. Encodes
 * arguments like React's `encodeReply`: plain JSON, or multipart with the
 * form fields under `_1_` and a `$K1` reference when a `FormData` is passed.
 */
export async function callServerAction(
  request: APIRequestContext,
  { id, path, args }: { id: string; path: string; args: unknown[] },
): Promise<APIResponse> {
  // Next rejects cross-origin action calls; this one is same-origin.
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const headers = {
    "Next-Action": id,
    Accept: "text/x-component",
    Origin: origin,
  };
  const form = args.find((arg) => arg instanceof FormFields);
  if (!form) {
    return request.post(path, {
      headers: { ...headers, "Content-Type": "text/plain;charset=UTF-8" },
      data: JSON.stringify(args),
      maxRedirects: 0,
    });
  }
  // The fields go first: the server decodes the stream as it arrives and
  // `$K1` only collects fields it has already seen.
  const multipart = new FormData();
  for (const [key, value] of Object.entries(form.fields)) {
    for (const item of [value].flat()) multipart.append(`_1_${key}`, item);
  }
  multipart.set(
    "0",
    JSON.stringify(args.map((arg) => (arg === form ? "$K1" : arg))),
  );
  return request.post(path, { headers, multipart, maxRedirects: 0 });
}

/** The action's return value from an RSC action response, if it has one. */
export function actionResult(body: string): unknown {
  // Row 0 points at the result row (`0:{"a":"$@1",…}`); rows come in any
  // order, and dev builds add debug chunks (`1:D…`) before the value.
  const lines = body.split("\n");
  const row = lines
    .map((line) => /^0:\{"a":"\$@([0-9a-f]+)"/.exec(line)?.[1])
    .find(Boolean);
  const value = lines
    .filter((line) => row && line.startsWith(`${row}:`))
    .map((line) => line.slice(row!.length + 1))
    .findLast((chunk) => /^[{[]/.test(chunk));
  return value === undefined ? undefined : JSON.parse(value);
}

export type ActionResponse = {
  status: number;
  /** The action's return value (`ActionResult`), when it returned one. */
  result: { ok: boolean; [key: string]: unknown } | null;
  body: string;
};

/**
 * Calls `file#name` as the user signed in on `page` (its cookies), on a page
 * that serves it, and parses the reply. Takes at most one `FormFields`.
 */
export async function callAction(
  page: Page,
  [file, name]: readonly [string, string],
  args: unknown[],
): Promise<ActionResponse> {
  const action = compiledServerActions().get(`${file}#${name}`);
  if (!action) {
    throw new Error(
      `Server action ${file}#${name} not found in the manifest. ` +
        "Build the app (`pnpm build`) or open a page that uses it first.",
    );
  }
  if (args.filter((arg) => arg instanceof FormFields).length > 1) {
    throw new Error("callAction encodes at most one FormFields argument.");
  }
  const response = await callServerAction(page.request, {
    id: action.id,
    path: action.path,
    args,
  });
  const body = await response.text();
  let result: unknown;
  try {
    result = actionResult(body);
  } catch {
    result = undefined;
  }
  return {
    status: response.status(),
    result:
      result && typeof result === "object"
        ? (result as ActionResponse["result"])
        : null,
    body,
  };
}
