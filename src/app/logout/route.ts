import { signOut } from "@/auth";

/**
 * Ends the session and goes to /login. Used to clear a token whose
 * membership no longer exists (`?reason=expired` shows the banner); the user
 * menu signs out with a server action instead.
 */
export async function GET(request: Request) {
  const reason = new URL(request.url).searchParams.get("reason");
  await signOut({
    redirectTo: reason === "expired" ? "/login?reason=expired" : "/login",
  });
}
