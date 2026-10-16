import { Suspense } from "react";

import { CalendarFeedPage } from "@/components/calendar-feed/calendar-page";
import { Skeleton } from "@/components/ui/skeleton";

/** Calendar subscription (notifications-substitutes.md §7). */
export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto h-64 w-full max-w-2xl" />}>
      <CalendarFeedPage />
    </Suspense>
  );
}
