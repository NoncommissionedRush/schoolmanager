import { cn } from "cn";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

export type Tone = "success" | "warning" | "info" | "danger" | "muted";

const alertTone: Record<Tone, string> = {
  success: "border-success-border bg-success-surface text-success",
  warning: "border-warning-border bg-warning-surface text-warning",
  info: "border-info-border bg-info-surface text-info",
  danger: "border-danger-border bg-danger-surface text-danger",
  muted: "bg-muted text-muted-foreground",
};

/** Status alert in a token colour (tokens.md), icon + sentence, never colour alone. */
export function ToneAlert({
  tone,
  icon: Icon,
  children,
  className,
  live,
}: {
  tone: Tone;
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
  /** Announce as a status update instead of an alert. */
  live?: boolean;
}) {
  return (
    <Alert
      className={cn(alertTone[tone], className)}
      role={live ? "status" : undefined}
    >
      <Icon aria-hidden="true" />
      <AlertDescription className="text-current">{children}</AlertDescription>
    </Alert>
  );
}

const badgeTone: Record<Tone, string> = {
  success: "border-success-border bg-success-surface text-success",
  warning: "border-warning-border bg-warning-surface text-warning",
  info: "border-info-border bg-info-surface text-info",
  danger: "border-danger-border bg-danger-surface text-danger",
  muted: "bg-muted text-muted-foreground",
};

export function ToneBadge({
  tone,
  icon: Icon,
  children,
}: {
  tone: Tone;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <Badge variant="outline" className={badgeTone[tone]}>
      {Icon && <Icon aria-hidden="true" />}
      {children}
    </Badge>
  );
}
