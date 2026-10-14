import { Skeleton } from "@/components/ui/skeleton";

/** Loading state of the dashboards: header + one card (§6). */
export function DashboardSkeleton({ narrow = false }: { narrow?: boolean }) {
  return (
    <div
      className={
        narrow
          ? "mx-auto flex max-w-md flex-col gap-4 md:gap-6"
          : "mx-auto flex max-w-screen-2xl flex-col gap-6"
      }
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>
      <Skeleton className="h-48 w-full rounded-lg" />
    </div>
  );
}
