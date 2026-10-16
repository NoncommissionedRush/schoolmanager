import { Star } from "lucide-react";

/** Read-only stars; the accessible name carries the value (never colour only). */
export function Stars({
  score,
  label,
  size = "size-4",
}: {
  score: number;
  /** e.g. "4 out of 5 stars". */
  label: string;
  size?: string;
}) {
  return (
    <span role="img" aria-label={label} className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          aria-hidden="true"
          className={
            n <= score
              ? `${size} fill-amber-500 stroke-amber-700`
              : `${size} stroke-muted-foreground`
          }
        />
      ))}
    </span>
  );
}
