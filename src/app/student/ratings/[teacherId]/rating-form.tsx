"use client";

import { CircleAlert, Info, Loader2, Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { ToneAlert } from "@/components/absences/tone";
import { useMessage } from "@/components/admin/use-message";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Message } from "@/server/admin/result";
import { RATING_COMMENT_MAX, RATING_SCORES } from "@/server/ratings/rules";

import { saveRatingAction } from "../actions";

/** The counter shows from 900 characters (design §6.4). */
const COUNTER_FROM = 900;

/**
 * Stars + comment (design §6.4). The stars are native radios (arrow keys,
 * screen readers for free), the chosen value's label is printed as text.
 */
export function RatingForm({
  teacherId,
  termId,
  termName,
  initial,
  editable,
}: {
  teacherId: string;
  termId: string;
  termName: string;
  initial: { score: number; comment: string; lastChanged: string } | null;
  editable: boolean;
}) {
  const t = useTranslations("ratings.form");
  const message = useMessage();
  const router = useRouter();
  const [score, setScore] = useState<number | null>(initial?.score ?? null);
  const [comment, setComment] = useState(initial?.comment ?? "");
  const [errors, setErrors] = useState<Record<string, Message>>({});
  const [failed, setFailed] = useState(false);
  const [closed, setClosed] = useState(!editable);
  const [pending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (score === null) {
      setErrors({ score: { key: "ratings.form.required" } });
      return;
    }
    startTransition(async () => {
      setFailed(false);
      setErrors({});
      const result = await saveRatingAction({
        teacherId,
        termId,
        score,
        comment,
      });
      if (!result.ok) {
        if (result.fieldErrors) setErrors(result.fieldErrors);
        else setFailed(true);
        return;
      }
      if (result.data.status === "closed") {
        setClosed(true);
        return;
      }
      toast.success(t("saved"));
      router.push("/student/ratings");
    });
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      {closed && (
        <ToneAlert tone="muted" icon={Info}>
          {t("closed", { term: termName })}
        </ToneAlert>
      )}
      {failed && (
        <ToneAlert tone="danger" icon={CircleAlert}>
          {t("error")}
        </ToneAlert>
      )}
      <fieldset
        className="flex flex-col gap-2"
        aria-describedby={errors.score ? "score-error" : undefined}
        disabled={closed}
      >
        <legend className="mb-2 text-sm font-medium">{t("stars")}</legend>
        <div className="flex gap-1">
          {RATING_SCORES.map((n) => (
            <label key={n} className="relative cursor-pointer">
              <input
                type="radio"
                name="score"
                value={n}
                checked={score === n}
                onChange={() => setScore(n)}
                className="peer sr-only"
                aria-label={t(`star.${n}`)}
              />
              <span className="flex size-11 items-center justify-center rounded-md peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                <Star
                  aria-hidden="true"
                  className={
                    score !== null && n <= score
                      ? "size-8 fill-amber-500 stroke-amber-700"
                      : "size-8 stroke-muted-foreground"
                  }
                />
              </span>
            </label>
          ))}
        </div>
        <span className="min-h-5 text-sm font-medium" aria-live="polite">
          {score !== null ? t(`star.${score}` as "star.1") : ""}
        </span>
        {errors.score && (
          <span id="score-error" className="text-sm text-destructive">
            {message(errors.score)}
          </span>
        )}
      </fieldset>
      <div className="flex flex-col gap-2">
        <Label htmlFor="rating-comment">{t("comment")}</Label>
        <Textarea
          id="rating-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={t("commentPlaceholder")}
          maxLength={RATING_COMMENT_MAX}
          rows={5}
          disabled={closed}
          aria-invalid={errors.comment ? true : undefined}
          aria-describedby={errors.comment ? "comment-error" : undefined}
        />
        <div className="flex justify-between text-sm text-muted-foreground">
          <span id="comment-error" className="text-destructive">
            {errors.comment && message(errors.comment)}
          </span>
          {comment.length >= COUNTER_FROM && (
            <span>
              {t("counter", { count: comment.length, max: RATING_COMMENT_MAX })}
            </span>
          )}
        </div>
      </div>
      {initial && (
        <p className="text-sm text-muted-foreground">
          {t("lastChanged", { date: initial.lastChanged })}
        </p>
      )}
      {!closed && (
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {pending ? t("saving") : initial ? t("saveChanges") : t("submit")}
        </Button>
      )}
    </form>
  );
}
