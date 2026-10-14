import { Skeleton } from "@/components/ui/skeleton";

/** Loading state of admin list pages (§5.6): header + 8 rows of bars. */
export function TableSkeleton() {
  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
      <Skeleton className="h-8 w-80" />
      <div className="flex flex-col gap-2 rounded-lg bg-background p-4">
        {Array.from({ length: 9 }, (_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    </div>
  );
}
