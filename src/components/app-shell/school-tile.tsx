import { cn } from "@/lib/utils";
import { initials } from "@/server/dashboard/greeting";

/** School "logo": initials on the primary color (no uploaded logos, §9). */
export function SchoolTile({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
