"use client";

import { AlertTriangle, CircleAlert, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { removeSubstituteAction } from "@/app/admin/substitutions/actions";
import { ToneAlert } from "@/components/absences/tone";
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
import { Checkbox } from "@/components/ui/checkbox";
import type { SubstituteSheet } from "@/server/substitutes/service";

import { useReasonText } from "./reason-text";
import { useLessonDay, useNotifyPreviewText } from "./substitute-sheet";

/**
 * Remove a substitute (design §5.4). Refused while the regular teacher
 * teaches another lesson then (`REGULAR_TEACHER_BUSY`); their other
 * warnings need "Remove anyway". The server re-checks on confirm.
 */
export function RemoveSubstituteDialog({
  open,
  onOpenChange,
  lesson,
  remove,
  expected,
  onRemoved,
  onFindAnother,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lesson: {
    id: string;
    groupName: string;
    startsAt: string;
    regular: string;
    substitute: string;
    phase: "upcoming" | "started" | "ended";
  };
  remove: NonNullable<SubstituteSheet["remove"]>;
  expected: SubstituteSheet["expected"];
  onRemoved?: () => void;
  /** Offered when the regular teacher is busy. */
  onFindAnother?: () => void;
}) {
  const t = useTranslations("substitutes");
  const router = useRouter();
  const day = useLessonDay();
  const reasonText = useReasonText();
  const notifyText = useNotifyPreviewText();
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<"changed" | "error" | "busy" | null>(null);
  const [pending, startTransition] = useTransition();
  const date = day(lesson.startsAt);

  const confirm = () =>
    startTransition(async () => {
      setError(null);
      const result = await removeSubstituteAction({
        lessonId: lesson.id,
        expectedSubstituteId: expected.substituteId,
        expectedStartsAt: expected.startsAt,
        acknowledgedKeys: acknowledged ? remove.reasons.map((r) => r.key) : [],
        reason: null,
      });
      if (!result.ok) return setError("error");
      const status = result.data.status;
      if (status === "done") {
        toast.success(
          t("removed", {
            substitute: lesson.substitute,
            group: lesson.groupName,
            date,
          }),
        );
        onOpenChange(false);
        onRemoved?.();
        router.refresh();
      } else if (status === "regularBusy") {
        setError("busy");
      } else if (status === "changed" || status === "lessonRefused") {
        setError("changed");
      } else {
        setError("error");
      }
    });

  const busy = remove.refused || error === "busy";
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("remove.title", {
              substitute: lesson.substitute,
              group: lesson.groupName,
              date,
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {busy
              ? t("remove.regularBusy", {
                  teacher: lesson.regular,
                  otherGroup: remove.otherGroup ?? "",
                })
              : [
                  t("remove.description", { teacher: lesson.regular }),
                  notifyText(
                    remove.notify,
                    lesson.groupName,
                    lesson.phase === "ended",
                  ),
                ].join(" ")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!busy && remove.reasons.length > 0 && (
          <ToneAlert tone="warning" icon={AlertTriangle}>
            <span className="flex flex-col gap-1">
              {t("remove.stillAway", { teacher: lesson.regular })}
              <ul className="list-disc pl-5">
                {remove.reasons.map((r) => (
                  <li key={r.key}>{reasonText(r)}</li>
                ))}
              </ul>
              <label className="mt-1 flex items-center gap-2 font-medium text-foreground">
                <Checkbox
                  checked={acknowledged}
                  onCheckedChange={(v) => setAcknowledged(v === true)}
                />
                {t("remove.anyway")}
              </label>
            </span>
          </ToneAlert>
        )}
        {error === "changed" && (
          <ToneAlert tone="warning" icon={AlertTriangle}>
            {t("lessonChanged")}
          </ToneAlert>
        )}
        {error === "error" && (
          <ToneAlert tone="danger" icon={CircleAlert}>
            {t("error.remove")}
          </ToneAlert>
        )}
        <AlertDialogFooter>
          {busy ? (
            <>
              <AlertDialogCancel>{t("remove.close")}</AlertDialogCancel>
              {onFindAnother && (
                <Button onClick={onFindAnother}>
                  {t("remove.findAnother")}
                </Button>
              )}
            </>
          ) : (
            <>
              <AlertDialogCancel>{t("remove.keep")}</AlertDialogCancel>
              <Button
                variant="destructive"
                disabled={
                  pending || (remove.reasons.length > 0 && !acknowledged)
                }
                onClick={confirm}
              >
                {pending && (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                )}
                {pending ? t("remove.removing") : t("remove.confirm")}
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
