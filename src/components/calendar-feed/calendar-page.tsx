import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";

import { db } from "@/lib/db";
import { getSchoolFormatter } from "@/i18n/school-format";
import { requireRole } from "@/server/auth/session";
import { loadMyFeed } from "@/server/calendar-feed/service";
import { scopeToSchool } from "@/server/db/school-scope";

import { CalendarFeedCard } from "./calendar-feed-client";

/** The origin the user reached the app on, for the absolute feed URL. */
async function requestOrigin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.")
      ? "http"
      : "https");
  return `${proto}://${host}`;
}

/**
 * Calendar subscription (notifications-substitutes.md §7) for teachers and
 * students: the private link, copy / subscribe / reset, and what's in it.
 */
export async function CalendarFeedPage() {
  const viewer = await requireRole("TEACHER", "STUDENT");
  const feed = await loadMyFeed(
    scopeToSchool(db, viewer.school.id),
    { userId: viewer.userId, role: viewer.role },
    await requestOrigin(),
  );
  const t = await getTranslations("calendarFeed");
  const format = await getSchoolFormatter(viewer.school);
  const student = viewer.role === "STUDENT";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </div>
      <CalendarFeedCard
        link={
          feed.link && {
            url: feed.link.url,
            createdOn: format.dateTime(feed.link.createdAt, "short"),
          }
        }
        revokedByAdmin={feed.revokedByAdmin}
      />
      <section className="flex flex-col gap-2" aria-labelledby="feed-contents">
        <h2 id="feed-contents" className="text-lg font-medium">
          {t("contents.title")}
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>{t("contents.range")}</li>
          <li>{t("contents.cancelled")}</li>
          {student && <li>{t("contents.notAttending")}</li>}
          <li>{t("contents.substitutes")}</li>
        </ul>
      </section>
      <section className="flex flex-col gap-2" aria-labelledby="feed-howto">
        <h2 id="feed-howto" className="text-lg font-medium">
          {t("howTo.title")}
        </h2>
        {(["google", "apple", "outlook"] as const).map((app) => (
          <details key={app} className="rounded-md border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">
              {t(`howTo.${app}Title`)}
            </summary>
            <p className="mt-2 text-muted-foreground">{t(`howTo.${app}`)}</p>
          </details>
        ))}
        <p className="text-sm text-muted-foreground">{t("refreshNote")}</p>
      </section>
    </div>
  );
}
