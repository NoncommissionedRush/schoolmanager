"use client";

import { Star } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const STORAGE_KEY = "ratings.homeCard.hiddenUntil";
/** _Not now_ hides the card for 7 days (design §6.3). */
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/** Student home: "Rate your teacher" while someone is open and unrated. */
export function RateTeacherCard({
  teacher,
  href,
}: {
  teacher: string;
  href: string;
}) {
  const t = useTranslations("ratings.home");
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const until = Number(window.localStorage.getItem(STORAGE_KEY) ?? 0);
    // Reading browser storage once after mount; nothing to subscribe to.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (until > Date.now()) setHidden(true);
  }, []);

  if (hidden) return null;
  return (
    <Card className="border-l-4 border-l-amber-500">
      <CardContent className="flex flex-col items-start gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Star aria-hidden="true" className="size-5 text-amber-600" />
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("question", { teacher })}
        </p>
        <div className="flex gap-2">
          <Link href={href} className={buttonVariants({ size: "lg" })}>
            {t("rateNow")}
          </Link>
          <Button
            variant="ghost"
            size="lg"
            onClick={() => {
              window.localStorage.setItem(
                STORAGE_KEY,
                String(Date.now() + SNOOZE_MS),
              );
              setHidden(true);
            }}
          >
            {t("notNow")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
