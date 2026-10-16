import { getTranslations } from "next-intl/server";

/** Five small bars, 5 → 1 stars, counts as text (design §6.5). */
export async function Distribution({
  counts,
}: {
  /** Index 0 = 1 star … 4 = 5 stars. */
  counts: readonly number[];
}) {
  const t = await getTranslations("ratings.admin");
  const max = Math.max(1, ...counts);
  const [one, two, three, four, five] = counts;
  return (
    <ul
      aria-label={t("distribution", { one, two, three, four, five })}
      className="flex flex-col gap-0.5 text-xs"
    >
      {[5, 4, 3, 2, 1].map((score) => (
        <li key={score} aria-hidden="true" className="flex items-center gap-1">
          <span className="w-2 tabular-nums">{score}</span>
          <span className="h-1.5 w-20 rounded-full bg-muted">
            <span
              className="block h-1.5 rounded-full bg-amber-500"
              style={{ width: `${(counts[score - 1] / max) * 100}%` }}
            />
          </span>
          <span className="text-muted-foreground tabular-nums">
            {counts[score - 1]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "★ 4.6" or "Too few to average" / "No ratings". */
export async function AverageText({
  average,
  count,
}: {
  average: number | null;
  count: number;
}) {
  const t = await getTranslations("ratings.admin");
  if (count === 0)
    return <span className="text-muted-foreground">{t("none")}</span>;
  if (average === null) {
    return <span className="text-muted-foreground">{t("tooFew")}</span>;
  }
  return (
    <span className="flex items-center gap-1 font-medium">
      <span aria-hidden="true" className="text-amber-600">
        ★
      </span>
      <span aria-hidden="true">{average.toFixed(1)}</span>
      <span className="sr-only">
        {t("average", { value: average.toFixed(1) })}
      </span>
    </span>
  );
}
