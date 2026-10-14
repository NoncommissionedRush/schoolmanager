"use client";

import { Info, Plus, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { useMessage } from "@/components/admin/use-message";
import { formatMinutes } from "@/components/timetable/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  firstOverlap,
  lessonTimeWarnings,
  MAX_LESSON_TIMES,
  type RoomInfo,
  weeklyMinutes,
} from "@/server/admin/groups/lesson-times";
import type { FieldErrors } from "@/server/admin/result";

import { saveLessonTimesAction } from "../actions";

const STEP = 15;
const TIMES = Array.from({ length: (24 * 60) / STEP + 1 }, (_, i) => i * STEP);
const QUICK_DURATIONS = [45, 60, 90];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

type Row = {
  key: number;
  weekday: number;
  startMinute: number;
  endMinute: number;
  roomId: string;
};

export type LessonTimesData = {
  groupId: string;
  groupName: string;
  archived: boolean;
  members: number;
  times: {
    weekday: number;
    startMinute: number;
    endMinute: number;
    roomId: string;
  }[];
  rooms: RoomInfo[];
  school: {
    teachingWeekdays: number[];
    dayStartMinute: number;
    dayEndMinute: number;
  };
  /** A published term the group has live slots in (Q2 alert). */
  currentTerm: { id: string; name: string } | null;
};

/** Lesson times card on the group's Details tab (§5.1). */
export function LessonTimesEditor({ data }: { data: LessonTimesData }) {
  const t = useTranslations("groups.lessonTimes");
  const tc = useTranslations("common");
  const tv = useTranslations("validation");
  const render = useMessage();
  const [pending, startTransition] = useTransition();
  const [nextKey, setNextKey] = useState(data.times.length);
  const [rows, setRows] = useState<Row[]>(() =>
    data.times.map((time, key) => ({ key, ...time })),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  const rooms = useMemo(
    () => new Map(data.rooms.map((room) => [room.id, room])),
    [data.rooms],
  );
  const selectableRooms = data.rooms.filter(
    (room) => !room.archived || rows.some((row) => row.roomId === room.id),
  );
  const overlapIndex = firstOverlap(rows);
  const warnings = lessonTimeWarnings(rows, rooms, data.members, data.school);
  const minutes = weeklyMinutes(rows);

  function update(key: number, patch: Partial<Row>) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  }

  function add() {
    const last = rows.at(-1);
    const fallbackRoom = data.rooms.find((room) => !room.archived)?.id ?? "";
    setRows((current) => [
      ...current,
      {
        key: nextKey,
        weekday: last ? Math.min(7, last.weekday + 2) : 1,
        startMinute: last?.startMinute ?? 17 * 60,
        endMinute: last?.endMinute ?? 18 * 60 + 30,
        // A new row copies the previous row's room (§5.1).
        roomId: last?.roomId ?? fallbackRoom,
      },
    ]);
    setNextKey((key) => key + 1);
  }

  function save() {
    setFormError(null);
    setErrors({});
    startTransition(async () => {
      const result = await saveLessonTimesAction(data.groupId, {
        times: rows.map((row) => ({
          weekday: row.weekday,
          startMinute: row.startMinute,
          endMinute: row.endMinute,
          roomId: row.roomId,
        })),
      });
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        if (result.formError) setFormError(render(result.formError));
        return;
      }
      setSavedOnce(true);
      if (result.message) toast.success(render(result.message));
    });
  }

  const rowError = (index: number) => {
    const entry = Object.entries(errors).find(([field]) =>
      field.startsWith(`times.${index}.`),
    );
    return entry ? render(entry[1]) : null;
  };

  return (
    <section
      aria-labelledby="lesson-times-title"
      className="flex flex-col gap-4"
      data-testid="lesson-times"
    >
      <div className="flex flex-col gap-1">
        <h2 id="lesson-times-title" className="text-lg font-medium">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("help")}</p>
      </div>
      {rows.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      )}
      <ol className="flex flex-col gap-3">
        {rows.map((row, index) => {
          const n = index + 1;
          const error = rowError(index);
          const rowWarnings = warnings.filter((w) => w.index === index);
          const room = rooms.get(row.roomId);
          return (
            <li
              key={row.key}
              className="flex flex-col gap-1.5"
              data-testid="lesson-time-row"
            >
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`lt-day-${row.key}`} className="text-xs">
                    {t("day")}
                  </Label>
                  <NativeSelect
                    id={`lt-day-${row.key}`}
                    aria-label={t("rowField", { field: t("day"), n })}
                    value={row.weekday}
                    disabled={data.archived}
                    onChange={(e) =>
                      update(row.key, { weekday: Number(e.target.value) })
                    }
                  >
                    {WEEKDAYS.map((day) => (
                      <NativeSelectOption key={day} value={day}>
                        {data.school.teachingWeekdays.includes(day)
                          ? tc(`weekday.${day}`)
                          : t("dayNoSchool", { day: tc(`weekday.${day}`) })}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`lt-start-${row.key}`} className="text-xs">
                    {t("start")}
                  </Label>
                  <NativeSelect
                    id={`lt-start-${row.key}`}
                    aria-label={t("rowField", { field: t("start"), n })}
                    value={row.startMinute}
                    disabled={data.archived}
                    onChange={(e) => {
                      const start = Number(e.target.value);
                      const length = row.endMinute - row.startMinute;
                      update(row.key, {
                        startMinute: start,
                        endMinute: Math.min(
                          24 * 60,
                          start + Math.max(length, STEP),
                        ),
                      });
                    }}
                  >
                    {TIMES.slice(0, -1).map((m) => (
                      <NativeSelectOption key={m} value={m}>
                        {formatMinutes(m)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`lt-end-${row.key}`} className="text-xs">
                    {t("end")}
                  </Label>
                  <NativeSelect
                    id={`lt-end-${row.key}`}
                    aria-label={t("rowField", { field: t("end"), n })}
                    value={row.endMinute}
                    disabled={data.archived}
                    onChange={(e) =>
                      update(row.key, { endMinute: Number(e.target.value) })
                    }
                  >
                    {TIMES.slice(1).map((m) => (
                      <NativeSelectOption key={m} value={m}>
                        {formatMinutes(m)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`lt-room-${row.key}`} className="text-xs">
                    {t("room")}
                  </Label>
                  <NativeSelect
                    id={`lt-room-${row.key}`}
                    aria-label={t("rowField", { field: t("room"), n })}
                    value={row.roomId}
                    disabled={data.archived}
                    onChange={(e) =>
                      update(row.key, { roomId: e.target.value })
                    }
                    aria-invalid={error ? true : undefined}
                  >
                    <NativeSelectOption value="" disabled>
                      {t("chooseRoom")}
                    </NativeSelectOption>
                    {selectableRooms.map((r) => (
                      <NativeSelectOption key={r.id} value={r.id}>
                        {r.online
                          ? t("roomOnline", { name: r.name })
                          : r.capacity !== null
                            ? t("roomSeats", {
                                name: r.name,
                                capacity: r.capacity,
                              })
                            : r.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <span className="pb-1.5 text-sm text-muted-foreground tabular-nums">
                  {row.endMinute > row.startMinute
                    ? t("duration", {
                        minutes: row.endMinute - row.startMinute,
                      })
                    : ""}
                </span>
                {!data.archived && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("removeRow", { n })}
                    onClick={() =>
                      setRows((current) =>
                        current.filter((r) => r.key !== row.key),
                      )
                    }
                  >
                    <X aria-hidden="true" />
                  </Button>
                )}
              </div>
              {!data.archived && (
                <div className="flex flex-wrap gap-1">
                  {QUICK_DURATIONS.map((length) => (
                    <Button
                      key={length}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      aria-label={t("quickDurationFor", { minutes: length, n })}
                      onClick={() =>
                        update(row.key, {
                          endMinute: Math.min(
                            24 * 60,
                            row.startMinute + length,
                          ),
                        })
                      }
                    >
                      {t("duration", { minutes: length })}
                    </Button>
                  ))}
                </div>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
              {row.endMinute <= row.startMinute && !error && (
                <p className="text-sm text-destructive">{tv("timeOrder")}</p>
              )}
              {rowWarnings.map((warning) => (
                <p
                  key={warning.code}
                  className="flex items-center gap-1.5 text-sm text-warning"
                >
                  <TriangleAlert aria-hidden="true" className="size-4" />
                  {warning.code === "ROOM_CAPACITY"
                    ? t("warning.capacity", {
                        room: room?.name ?? "",
                        capacity: warning.capacity,
                        members: warning.members,
                      })
                    : t(`warning.${warning.code}`)}
                </p>
              ))}
            </li>
          );
        })}
      </ol>
      {!data.archived && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={add}
            disabled={rows.length >= MAX_LESSON_TIMES}
          >
            <Plus aria-hidden="true" />
            {t("add")}
          </Button>
        </div>
      )}
      <p className="text-sm" aria-live="polite">
        {overlapIndex >= 0 ? (
          <span className="text-destructive">{tv("lessonTimesOverlap")}</span>
        ) : rows.length > 0 ? (
          t("summary", {
            count: rows.length,
            hours: Math.round((minutes / 60) * 100) / 100,
          })
        ) : null}
      </p>
      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      {savedOnce && data.currentTerm && (
        <Alert>
          <Info aria-hidden="true" />
          <AlertDescription className="flex flex-col items-start gap-1">
            {t("changedNote", { term: data.currentTerm.name })}
            <Link
              href={`/admin/timetable/edit?term=${data.currentTerm.id}&group=${data.groupId}&view=week`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t("changeCurrent")}
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {!data.archived && (
        <div>
          <Button
            type="button"
            onClick={save}
            disabled={pending || overlapIndex >= 0}
          >
            {t("save")}
          </Button>
        </div>
      )}
    </section>
  );
}
