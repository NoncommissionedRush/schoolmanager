import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { Inter } from "next/font/google";

import { ThemeProvider } from "@/components/theme/theme-provider";

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
    // next-themes sets the theme class on <html> before hydration.
    <html
      lang={locale}
      className={`${inter.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
