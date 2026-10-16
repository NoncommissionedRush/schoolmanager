"use client";

import { EyeOff, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { setRatingHiddenAction } from "../actions";

/**
 * _Hide rating_ / _Unhide_ (design §6.5). No confirm dialog: hiding can be
 * undone from the toast.
 */
export function HideRatingButton({
  ratingId,
  hidden,
}: {
  ratingId: string;
  hidden: boolean;
}) {
  const t = useTranslations("ratings.admin.detail");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const set = (hide: boolean) =>
    startTransition(async () => {
      const result = await setRatingHiddenAction({ ratingId, hidden: hide });
      router.refresh();
      if (!result.ok) return;
      if (hide) {
        toast.success(t("hidden"), {
          action: { label: t("undo"), onClick: () => set(false) },
        });
      } else {
        toast.success(t("unhidden"));
      }
    });

  return (
    <Button
      variant={hidden ? "outline" : "ghost"}
      size="sm"
      disabled={pending}
      onClick={() => set(!hidden)}
    >
      {pending ? (
        <Loader2 aria-hidden="true" className="animate-spin" />
      ) : (
        !hidden && <EyeOff aria-hidden="true" />
      )}
      {hidden ? t("unhide") : t("hide")}
    </Button>
  );
}
