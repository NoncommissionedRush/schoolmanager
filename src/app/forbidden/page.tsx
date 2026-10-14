import { ErrorPage } from "@/components/error-page";

// Target of the proxy's rewrite for another role's area. The proxy asks for
// a 403; `next dev` sends it, but production builds with Cache Components
// answer rewrites to a prerendered page with 200 — the page content is
// what's guaranteed.
export default function ForbiddenPage() {
  return <ErrorPage kind="forbidden" />;
}
