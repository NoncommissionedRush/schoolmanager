import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

type AnyQuery = (...args: unknown[]) => unknown;

/**
 * A pg client that runs promise-style queries one after another.
 *
 * Inside an interactive transaction Prisma sends independent queries (relation
 * loads, `Promise.all` over `tx`) to the same connection without waiting. pg
 * queues them but logs a deprecation warning, and pg@9 drops that queue.
 * Callback and submittable queries are passed through untouched; only
 * pg-pool uses those, and never concurrently on one client.
 */
class SerialPgClient extends pg.Client {
  #tail: Promise<unknown> = Promise.resolve();

  // Typed `never` only to satisfy every overload of pg's `query`.
  query(...args: unknown[]): never {
    const query = super.query as AnyQuery;
    const last = args.at(-1);
    const first = args[0] as { submit?: unknown } | undefined;
    if (typeof last === "function" || typeof first?.submit === "function") {
      return query.apply(this, args) as never;
    }
    const run = this.#tail.then(() => query.apply(this, args));
    this.#tail = run.catch(() => {});
    return run as never;
  }
}

export const SerialClient = SerialPgClient as typeof pg.Client;

export function createPgAdapter(connectionString: string | undefined) {
  return new PrismaPg({ connectionString, Client: SerialClient });
}
