"use client";

import { UserRoundCog } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { loadSubstituteSheetAction } from "@/app/admin/substitutions/actions";
import { Button } from "@/components/ui/button";
import type { SubstituteSheet as SheetData } from "@/server/substitutes/service";

import { RemoveSubstituteDialog } from "./remove-dialog";
import { SubstituteSheet } from "./substitute-sheet";

/**
 * The admin lesson page's substitute actions (design §5.3, §5.5):
 * _Find substitute…_, or _Change substitute…_ and _Remove substitute…_
 * when there is one. Also how a substitute is recorded after the lesson.
 */
export function SubstituteActions({
  lessonId,
  hasSubstitute,
}: {
  lessonId: string;
  hasSubstitute: boolean;
}) {
  const t = useTranslations("substitutes");
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<SheetData | null>(null);
  const [loading, startLoading] = useTransition();

  const openRemove = () =>
    startLoading(async () => {
      const result = await loadSubstituteSheetAction(lessonId);
      if (result.ok && result.data.remove) setRemoving(result.data);
      else toast.error(t("error.remove"));
    });

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <UserRoundCog aria-hidden="true" />
        {hasSubstitute ? t("change") : t("findEllipsis")}
      </Button>
      {hasSubstitute && (
        <Button variant="outline" disabled={loading} onClick={openRemove}>
          {t("removeAction")}
        </Button>
      )}
      <SubstituteSheet
        lessonId={open ? lessonId : null}
        onClose={() => setOpen(false)}
      />
      {removing?.remove && removing.lesson.substitute && (
        <RemoveSubstituteDialog
          open
          onOpenChange={(next) => !next && setRemoving(null)}
          lesson={{
            id: lessonId,
            groupName: removing.lesson.groupName,
            startsAt: removing.lesson.startsAt,
            regular: removing.lesson.regular.name,
            substitute: removing.lesson.substitute.name,
            phase: removing.lesson.phase,
          }}
          remove={removing.remove}
          expected={removing.expected}
          onRemoved={() => setRemoving(null)}
          onFindAnother={() => {
            setRemoving(null);
            setOpen(true);
          }}
        />
      )}
    </>
  );
}
