import { Suspense } from "react";
import { GraduationCap } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { ListFilters } from "@/components/admin/list-filters";
import {
  ArchivedBadge,
  NoResults,
  PageHeader,
  TableCard,
} from "@/components/admin/list";
import { EmptyState } from "@/components/empty-state";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminContext } from "@/server/admin/context";
import { parseListParams } from "@/server/admin/list";
import { listLevels } from "@/server/admin/levels/service";

import { LevelRowActions, NewLevelButton, PresetButton } from "./levels-client";
import { TableSkeleton } from "@/components/admin/table-skeleton";

const PATH = "/admin/levels";

async function LevelsPage({ searchParams }: PageProps<"/admin/levels">) {
  const { db } = await adminContext();
  const t = await getTranslations("levels");
  const tc = await getTranslations("common");
  const { status } = parseListParams(await searchParams);
  const { levels, anyCount } = await listLevels(db, status);

  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={anyCount > 0 && <NewLevelButton />}
      />
      {anyCount === 0 ? (
        <div className="flex flex-col items-center gap-4">
          <EmptyState
            icon={GraduationCap}
            title={t("empty.title")}
            description={t("empty.description")}
          />
          <div className="flex flex-wrap justify-center gap-2">
            <PresetButton />
            <NewLevelButton label={t("empty.action")} outline />
          </div>
        </div>
      ) : (
        <>
          <ListFilters count={t("caption", { count: levels.length })} />
          {levels.length === 0 ? (
            <NoResults
              entities={t("entities")}
              archived={status === "archived"}
              clearHref={PATH}
            />
          ) : (
            <TableCard>
              <Table>
                <TableCaption className="sr-only">
                  {t("caption", { count: levels.length })}
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">{t("col.order")}</TableHead>
                    <TableHead>{t("col.code")}</TableHead>
                    <TableHead>{t("col.name")}</TableHead>
                    <TableHead>{t("col.students")}</TableHead>
                    <TableHead>{t("col.groups")}</TableHead>
                    <TableHead>
                      <span className="sr-only">{tc("edit")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {levels.map((level) => (
                    <TableRow key={level.id}>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {level.position}
                      </TableCell>
                      <TableCell className="font-medium">
                        <span className="flex items-center gap-2">
                          {level.code}
                          {level.archivedAt && <ArchivedBadge />}
                        </span>
                      </TableCell>
                      <TableCell
                        className="max-w-xs truncate"
                        title={level.name}
                      >
                        {level.name}
                      </TableCell>
                      <TableCell>{level.students}</TableCell>
                      <TableCell>{level.groups}</TableCell>
                      <TableCell className="text-right">
                        <LevelRowActions
                          level={{
                            id: level.id,
                            code: level.code,
                            name: level.name,
                            archived: !!level.archivedAt,
                            students: level.students,
                            groups: level.groups,
                            usage: level.usage,
                            canMoveUp: level.canMoveUp,
                            canMoveDown: level.canMoveDown,
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableCard>
          )}
        </>
      )}
    </div>
  );
}

// Own Suspense boundary: client navigations between admin pages re-render
// below the shared layout, so the shell's boundary doesn't cover them.
export default function Page(props: Parameters<typeof LevelsPage>[0]) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <LevelsPage {...props} />
    </Suspense>
  );
}
