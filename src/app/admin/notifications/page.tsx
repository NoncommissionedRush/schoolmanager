import { Suspense } from "react";

import {
  InboxPage,
  InboxSkeleton,
} from "@/components/notifications/inbox-page";

async function Inbox({ searchParams }: PageProps<"/admin/notifications">) {
  return <InboxPage role="ADMIN" searchParams={await searchParams} />;
}

export default function Page(props: PageProps<"/admin/notifications">) {
  return (
    <Suspense fallback={<InboxSkeleton />}>
      <Inbox {...props} />
    </Suspense>
  );
}
