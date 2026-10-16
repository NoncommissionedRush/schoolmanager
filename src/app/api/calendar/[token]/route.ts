import { createHash } from "node:crypto";

import { createTranslator } from "next-intl";
import { connection } from "next/server";

import { db } from "@/lib/db";
import { buildFeed, type FeedTranslate } from "@/server/calendar-feed/build";
import { loadFeedByToken } from "@/server/calendar-feed/service";
import { parseFeedSegment } from "@/server/calendar-feed/token";

import { defaultLocale } from "@/i18n/config";
import { loadMessages } from "@/i18n/messages";

/**
 * The calendar feed (docs/architecture/phase5-rules.md §5.2):
 * `GET /api/calendar/<token>.ics`, no session. Authenticated by the token
 * alone; any failure is a 404 with an empty body, so nothing reveals
 * whether a user, link or school exists. The token is never logged.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/calendar/[token]">,
) {
  await connection();
  const token = parseFeedSegment((await params).token);
  if (!token) return notFound();
  const now = new Date();
  const feed = await loadFeedByToken(db, token, now);
  if (!feed) return notFound();

  const intl = createTranslator({
    locale: defaultLocale,
    messages: await loadMessages(defaultLocale),
  });
  const t: FeedTranslate = (key, values) =>
    (intl as unknown as (k: string, v?: object) => string)(key, values);
  const body = buildFeed(
    feed.lessons,
    {
      role: feed.role,
      schoolName: feed.school.name,
      timeZone: feed.school.timezone,
      baseUrl: new URL(request.url).origin,
    },
    t,
    // DTSTAMP changes every request, so the ETag is computed without it.
    now,
  );
  const etag = `"${createHash("sha256")
    .update(body.replace(/^DTSTAMP:.*\r\n/gm, ""))
    .digest("base64url")}"`;
  const headers = {
    "Cache-Control": "private, max-age=900",
    ETag: etag,
    "X-Robots-Tag": "noindex",
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, {
    headers: {
      ...headers,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="lessons.ics"',
    },
  });
}

const notFound = () =>
  new Response(null, {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
