import type { LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

/** First-use empty state: muted icon, h2 title, one sentence (§6). */
export function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
        <Icon aria-hidden="true" className="size-10 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}
