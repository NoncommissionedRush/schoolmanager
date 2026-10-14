import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ROLE_HOME } from "@/server/auth/roles";
import { requireViewer } from "@/server/auth/session";

// The proxy already redirects "/" to the user's dashboard (or /login); this
// is the fallback if the proxy is bypassed.
export default function Home() {
  return (
    <Suspense>
      <RedirectToDashboard />
    </Suspense>
  );
}

async function RedirectToDashboard(): Promise<never> {
  const viewer = await requireViewer();
  redirect(ROLE_HOME[viewer.role]);
}
