import { ErrorPage } from "@/components/error-page";

// Rendered by `forbidden()` (e.g. `requireRole` with the wrong role).
export default function Forbidden() {
  return <ErrorPage kind="forbidden" />;
}
