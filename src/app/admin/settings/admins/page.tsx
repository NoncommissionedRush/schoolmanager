import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { ListFilters } from "@/components/admin/list-filters";
import {
  ArchivedBadge,
  listHref,
  NoResults,
  PageHeader,
  Pagination,
  TableCard,
} from "@/components/admin/list";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listAdmins } from "@/server/admin/admins/service";
import { adminContext } from "@/server/admin/context";
import { parseListParams } from "@/server/admin/list";

import { AdminRowActions, NewAdminButton } from "./admins-client";
import { TableSkeleton } from "@/components/admin/table-skeleton";

const PATH = "/admin/settings/admins";

async function AdminsPage({
  searchParams,
}: PageProps<"/admin/settings/admins">) {
  const { db, viewer } = await adminContext();
  const t = await getTranslations("admins");
  const tc = await getTranslations("common");
  const list = parseListParams(await searchParams);
  const { admins, total, window, activeCount } = await listAdmins(db, list);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("description", { count: activeCount })}
        actions={<NewAdminButton />}
      />
      <ListFilters
        searchLabel={t("search")}
        count={t("caption", { count: total })}
      />
      {admins.length === 0 ? (
        <NoResults
          entities={t("entities")}
          archived={list.status === "archived" && !list.q}
          clearHref={PATH}
        />
      ) : (
        <>
          <TableCard>
            <Table>
              <TableCaption className="sr-only">
                {t("caption", { count: total })}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("col.name")}</TableHead>
                  <TableHead>{t("col.email")}</TableHead>
                  <TableHead>{t("col.status")}</TableHead>
                  <TableHead>
                    <span className="sr-only">{tc("edit")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {admins.map((admin) => {
                  const self = admin.userId === viewer.userId;
                  return (
                    <TableRow key={admin.userId}>
                      <TableCell className="font-medium">
                        <span className="flex items-center gap-2">
                          {admin.name}
                          {self && <Badge variant="outline">{tc("you")}</Badge>}
                        </span>
                      </TableCell>
                      <TableCell>{admin.email}</TableCell>
                      <TableCell>
                        {admin.archived ? (
                          <ArchivedBadge />
                        ) : (
                          <Badge variant="outline">{tc("status.active")}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <AdminRowActions admin={{ ...admin, self }} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableCard>
          <Pagination
            window={window}
            total={total}
            hrefFor={(page) =>
              listHref(PATH, { q: list.q, status: list.status, page })
            }
          />
        </>
      )}
    </div>
  );
}

// Own Suspense boundary: client navigations between admin pages re-render
// below the shared layout, so the shell's boundary doesn't cover them.
export default function Page(props: Parameters<typeof AdminsPage>[0]) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <AdminsPage {...props} />
    </Suspense>
  );
}
