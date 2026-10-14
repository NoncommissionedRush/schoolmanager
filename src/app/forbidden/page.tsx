import { forbidden } from "next/navigation";

// Target of the proxy's rewrite for another role's area. A rewrite's own
// status doesn't survive production builds with Cache Components (the
// prerendered page answers 200), so the page throws `forbidden()`: that
// renders src/app/forbidden.tsx with a 403 in dev and production alike.
export default function ForbiddenPage() {
  forbidden();
}
