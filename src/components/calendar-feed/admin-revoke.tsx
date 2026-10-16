"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { revokeCalendarFeedAction } from "@/app/admin/_people/calendar-actions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * Admin: _Turn off calendar link…_ on a teacher's or student's page
 * (notifications-substitutes.md §7.4). Shown only while they have a link;
 * the admin never sees the link and no new one is created.
 */
export function RevokeCalendarLink({
  userId,
  name,
}: {
  userId: string;
  name: string;
}) {
  const t = useTranslations("calendarFeed.admin");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const revoke = () =>
    startTransition(async () => {
      const result = await revokeCalendarFeedAction(userId);
      setOpen(false);
      if (result.ok) toast.success(t("revoked"));
      router.refresh();
    });

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {t("revokeButton")}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revoke.title", { name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("revoke.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("revoke.cancel")}</AlertDialogCancel>
            <Button variant="destructive" disabled={pending} onClick={revoke}>
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {t("revoke.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
