import { Suspense } from "react";
import { DoorOpen, ExternalLink, Video } from "lucide-react";
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
import { param, parseListParams } from "@/server/admin/list";
import { listRooms } from "@/server/admin/rooms/service";
import { schoolToday } from "@/server/admin/shared";

import { NewRoomButton, RoomRowActions } from "./rooms-client";
import { TableSkeleton } from "@/components/admin/table-skeleton";

const PATH = "/admin/settings/rooms";

async function RoomsPage({ searchParams }: PageProps<"/admin/settings/rooms">) {
  const { db, viewer } = await adminContext();
  const t = await getTranslations("rooms");
  const tc = await getTranslations("common");
  const params = await searchParams;
  const list = parseListParams(params);
  const kindParam = param(params, "kind");
  const kind =
    kindParam === "PHYSICAL" || kindParam === "ONLINE" ? kindParam : null;
  const { rooms, total, window, activeCount, anyCount } = await listRooms(
    db,
    { ...list, kind },
    schoolToday(viewer.school.timezone),
  );

  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("description", { count: activeCount })}
        actions={anyCount > 0 && <NewRoomButton />}
      />
      {anyCount === 0 ? (
        <div className="flex flex-col items-center gap-4">
          <EmptyState
            icon={DoorOpen}
            title={t("empty.title")}
            description={t("empty.description")}
          />
          <NewRoomButton label={t("empty.action")} />
        </div>
      ) : (
        <>
          <ListFilters
            searchLabel={t("search")}
            count={t("caption", { count: total })}
            selects={[
              {
                name: "kind",
                label: t("filter.kind"),
                defaultValue: "",
                options: [
                  { value: "", label: t("filter.all") },
                  { value: "PHYSICAL", label: t("kind.PHYSICAL") },
                  { value: "ONLINE", label: t("kind.ONLINE") },
                ],
              },
            ]}
          />
          {rooms.length === 0 ? (
            <NoResults
              entities={t("entities")}
              archived={list.status === "archived" && !list.q && !kind}
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
                      <TableHead>{t("col.kind")}</TableHead>
                      <TableHead>{t("col.capacity")}</TableHead>
                      <TableHead>{t("col.meetingUrl")}</TableHead>
                      <TableHead>{t("col.usedIn")}</TableHead>
                      <TableHead>
                        <span className="sr-only">{tc("edit")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rooms.map((room) => (
                      <TableRow key={room.id}>
                        <TableCell className="font-medium">
                          <span className="flex items-center gap-2">
                            {room.name}
                            {room.archivedAt && <ArchivedBadge />}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="flex items-center gap-1.5">
                            {room.kind === "ONLINE" ? (
                              <Video aria-hidden="true" className="size-4" />
                            ) : (
                              <DoorOpen aria-hidden="true" className="size-4" />
                            )}
                            {t(`kind.${room.kind}`)}
                          </span>
                        </TableCell>
                        <TableCell>
                          {room.capacity ??
                            (room.kind === "ONLINE"
                              ? t("noCapacity")
                              : tc("none"))}
                        </TableCell>
                        <TableCell>
                          {room.meetingUrl ? (
                            <a
                              href={room.meetingUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              title={room.meetingUrl}
                              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                            >
                              {new URL(room.meetingUrl).host}
                              <ExternalLink
                                aria-hidden="true"
                                className="size-3.5"
                              />
                              <span className="sr-only">
                                {tc("opensInNewTab")}
                              </span>
                            </a>
                          ) : (
                            tc("none")
                          )}
                        </TableCell>
                        <TableCell>{room.activeSlots}</TableCell>
                        <TableCell className="text-right">
                          <RoomRowActions
                            room={{
                              id: room.id,
                              name: room.name,
                              kind: room.kind,
                              capacity: room.capacity,
                              meetingUrl: room.meetingUrl,
                              archived: !!room.archivedAt,
                              activeSlots: room.activeSlots,
                            }}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableCard>
              <Pagination
                window={window}
                total={total}
                hrefFor={(page) =>
                  listHref(PATH, { q: list.q, status: list.status, kind, page })
                }
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

// Own Suspense boundary: client navigations between admin pages re-render
// below the shared layout, so the shell's boundary doesn't cover them.
export default function Page(props: Parameters<typeof RoomsPage>[0]) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <RoomsPage {...props} />
    </Suspense>
  );
}
