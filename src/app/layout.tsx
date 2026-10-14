import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { Inter } from "next/font/google";
import "./globals.css";

// Typography per docs/design/tokens.md §2.
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin", "latin-ext"],
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadata");
  return {
    title: t("title"),
    description: t("description"),
  };
}

// `NextIntlClientProvider` sits lower in the tree: the app shell passes the
// school's time zone, public pages use the defaults.
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${inter.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
