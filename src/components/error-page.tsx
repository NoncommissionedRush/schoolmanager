import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

/** Full-page 403 / 404 with a link back to the user's dashboard (§6). */
export async function ErrorPage({ kind }: { kind: "forbidden" | "notFound" }) {
  const t = await getTranslations(`errors.${kind}`);
  return (
    <main
      id="content"
      className="flex min-h-svh flex-col items-center justify-center gap-4 bg-muted p-6 text-center"
    >
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {t("description")}
      </p>
      {/* "/" sends signed-in users to their own dashboard. */}
      <Link href="/" className={buttonVariants({ size: "lg" })}>
        {t("action")}
      </Link>
    </main>
  );
}
