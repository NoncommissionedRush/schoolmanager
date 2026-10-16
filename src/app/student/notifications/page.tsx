import { Suspense } from "react";

import {
  InboxPage,
  InboxSkeleton,
} from "@/components/notifications/inbox-page";

async function Inbox({ searchParams }: PageProps<"/student/notifications">) {
  return <InboxPage role="STUDENT" searchParams={await searchParams} />;
}

export default function Page(props: PageProps<"/student/notifications">) {
  return (
    <Suspense fallback={<InboxSkeleton />}>
      <Inbox {...props} />
    </Suspense>
  );
}
