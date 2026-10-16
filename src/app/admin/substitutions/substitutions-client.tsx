"use client";

import {
  EllipsisVertical,
  Loader2,
  User,
  UserRoundCog,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { useMessage } from "@/components/admin/use-message";
import { EmptyState } from "@/components/empty-state";
import { RemoveSubstituteDialog } from "@/components/substitutes/remove-dialog";
import {
  SubstituteSheet,
  useLessonDay,
} from "@/components/substitutes/substitute-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Message } from "@/server/admin/result";
import type {
  SubstituteSheet as SheetData,
  SubstitutionRow,
} from "@/server/substitutes/service";

import { coverTeacherAction, loadSubstituteSheetAction } from "./actions";

const SOON_MS = 48 * 3_600_000;

/** _Cover a teacher…_ (design §5.2): teacher, dates, "also mark away". */
export function CoverTeacherButton({
  teachers,
  today,
}: {
  teachers: { id: string; name: string }[];
  today: string;
}) {
  const t = useTranslations("substitutes.coverTeacher");
  const render = useMessage();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [teacherId, setTeacherId] = useState("");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [markAway, setMarkAway] = useState(true);
  const [error, setError] = useState<Message | null>(null);
  const [pending, startTransition] = useTransition();
  const teacher = teachers.find((x) => x.id === teacherId);

  const submit = () =>
    startTransition(async () => {
      setError(null);
      if (!teacherId) {
        setError({ key: "validation.requiredField" });
        return;
      }
      const result = await coverTeacherAction({
        teacherId,
        from,
        to,
        markAway,
      });
      if (!result.ok) {
        setError(
          Object.values(result.fieldErrors ?? {})[0] ??
            result.formError ?? { key: "common.error.unexpected" },
        );
        return;
      }
      if (result.data.marked > 0) {
        toast.success(t("marked", { count: result.data.marked }));
      }
      setOpen(false);
      router.push(
        `/admin/substitutions?teacher=${teacherId}&from=${from}&to=${to}&all=1`,
      );
    });

  return (
    <>
      <Button onClick={() => setOpen(true)}>{t("action")}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="cover-teacher">{t("teacher")}</Label>
              <NativeSelect
                id="cover-teacher"
                value={teacherId}
                onChange={(e) => setTeacherId(e.target.value)}
                className="w-full"
              >
                <NativeSelectOption value="">
                  {t("chooseTeacher")}
                </NativeSelectOption>
                {teachers.map((x) => (
                  <NativeSelectOption key={x.id} value={x.id}>
                    {x.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="cover-from">{t("from")}</Label>
                <Input
                  id="cover-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="cover-to">{t("to")}</Label>
                <Input
                  id="cover-to"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={markAway}
                onCheckedChange={(v) => setMarkAway(v === true)}
              />
              {teacher
                ? t("markAway", { teacher: teacher.name })
                : t("markAwayGeneric")}
            </label>
            {error && (
              <p className="text-sm text-danger" role="alert">
                {render(error)}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {t("submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The table of one tab, with the sheet and the remove dialog. */
export function SubstitutionsList({
  tab,
  rows,
  emptyTeacher,
  filtered,
  now,
}: {
  tab: "needsCover" | "covered" | "past";
  rows: SubstitutionRow[];
  /** "Cover a teacher" mode: the teacher whose lessons are listed. */
  emptyTeacher: string | null;
  filtered: boolean;
  now: string;
}) {
  const t = useTranslations("substitutes");
  const tc = useTranslations("common");
  const format = useFormatter();
  const day = useLessonDay();
  const [sheetLesson, setSheetLesson] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{
    row: SubstitutionRow;
    data: SheetData;
  } | null>(null);
  const [, startLoading] = useTransition();

  const when = (row: SubstitutionRow) => {
    const start = new Date(row.startsAt);
    return `${format.dateTime(start, {
      weekday: "short",
      day: "numeric",
      month: "short",
    })} ${format.dateTime(start, { hour: "2-digit", minute: "2-digit" })}–${format.dateTime(
      new Date(row.endsAt),
      { hour: "2-digit", minute: "2-digit" },
    )}`;
  };
  const why = (row: SubstitutionRow) => {
    const n = row.needsCover;
    if (!n) return t("why.none", { teacher: row.teacher.name });
    const reason = n.reasons[0];
    const values = { otherGroup: n.otherGroup ?? "" };
    return n.who === "SUBSTITUTE"
      ? t(`why.substitute.${reason}`, values)
      : t(`why.${reason}`, values);
  };

  const openRemove = (row: SubstitutionRow) =>
    startLoading(async () => {
      const result = await loadSubstituteSheetAction(row.lessonId);
      if (result.ok && result.data.remove) {
        setRemoving({ row, data: result.data });
      } else {
        toast.error(t("error.remove"));
      }
    });

  const onAssigned = (lessonId: string) => {
    if (tab !== "needsCover") return;
    const index = rows.findIndex((r) => r.lessonId === lessonId);
    const next = rows.slice(index + 1).find((r) => r.needsCover);
    if (next) {
      // The sheet's own success toast is already up; offer the next one.
      toast(t("nextLesson"), {
        action: {
          label: t("find"),
          onClick: () => setSheetLesson(next.lessonId),
        },
      });
    }
  };

  if (rows.length === 0) {
    return emptyTeacher ? (
      <EmptyState
        icon={UserRoundCog}
        title={t("empty.teacherLessons", { teacher: emptyTeacher })}
      />
    ) : filtered ? (
      <Card className="py-10 text-center text-sm text-muted-foreground">
        {tc("noResults")}
      </Card>
    ) : tab === "needsCover" ? (
      <EmptyState
        icon={UserRoundCog}
        title={t("empty.needsCover.title")}
        description={t("empty.needsCover.description")}
      />
    ) : (
      <EmptyState icon={UserRoundCog} title={t(`empty.${tab}`)} />
    );
  }

  return (
    <>
      <Card className="overflow-hidden p-0">
        <Table data-testid={`substitutions-${tab}`}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col.when")}</TableHead>
              <TableHead>{t("col.lesson")}</TableHead>
              <TableHead>{t("col.teacher")}</TableHead>
              {tab === "needsCover" ? (
                <TableHead>{t("col.why")}</TableHead>
              ) : (
                <>
                  <TableHead>{t("col.substitute")}</TableHead>
                  <TableHead>{t("col.assigned")}</TableHead>
                </>
              )}
              <TableHead>
                <span className="sr-only">{t("col.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const soon =
                tab === "needsCover" &&
                new Date(row.startsAt).getTime() - new Date(now).getTime() <
                  SOON_MS;
              const TypeIcon = row.groupType === "ONE_ON_ONE" ? User : Users;
              return (
                <TableRow key={row.lessonId}>
                  <TableCell className="tabular-nums">
                    <span className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/admin/lessons/${row.lessonId}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {when(row)}
                      </Link>
                      {soon && (
                        <Badge className="border-danger-border bg-danger-surface text-danger">
                          {t("soon")}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <TypeIcon
                        aria-hidden="true"
                        className="size-4 text-muted-foreground"
                      />
                      <span className="sr-only">
                        {t(`type.${row.groupType}`)}
                      </span>
                      {t("picker.lessonLine", {
                        group: row.groupName,
                        type: t(`type.${row.groupType}`),
                        level: row.level ?? "none",
                      })}
                    </span>
                  </TableCell>
                  <TableCell>
                    {row.needsCover?.who === "SUBSTITUTE" && row.substitute
                      ? t("teacherIsSubstitute", { name: row.substitute.name })
                      : row.teacher.name}
                  </TableCell>
                  {tab === "needsCover" ? (
                    <TableCell>{why(row)}</TableCell>
                  ) : (
                    <>
                      <TableCell>
                        <span className="flex items-center gap-1.5">
                          <UserRoundCog
                            aria-hidden="true"
                            className="size-4 text-lesson-substitute-text"
                          />
                          {row.substitute?.name}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.assigned
                          ? t("assignedBy", {
                              name: row.assigned.by ?? "—",
                              date: day(row.assigned.at),
                            })
                          : "—"}
                      </TableCell>
                    </>
                  )}
                  <TableCell className="text-right">
                    {tab === "needsCover" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSheetLesson(row.lessonId)}
                      >
                        {t("find")}
                      </Button>
                    ) : row.editable ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t("rowMenu", {
                                group: row.groupName,
                                date: day(row.startsAt),
                              })}
                            />
                          }
                        >
                          <EllipsisVertical aria-hidden="true" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => setSheetLesson(row.lessonId)}
                          >
                            {t("change")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openRemove(row)}>
                            {t("removeAction")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
      <SubstituteSheet
        lessonId={sheetLesson}
        onClose={() => setSheetLesson(null)}
        onAssigned={onAssigned}
      />
      {removing && removing.data.remove && removing.data.lesson.substitute && (
        <RemoveSubstituteDialog
          open
          onOpenChange={(open) => !open && setRemoving(null)}
          lesson={{
            id: removing.row.lessonId,
            groupName: removing.data.lesson.groupName,
            startsAt: removing.data.lesson.startsAt,
            regular: removing.data.lesson.regular.name,
            substitute: removing.data.lesson.substitute.name,
            phase: removing.data.lesson.phase,
          }}
          remove={removing.data.remove}
          expected={removing.data.expected}
          onRemoved={() => setRemoving(null)}
          onFindAnother={() => {
            setSheetLesson(removing.row.lessonId);
            setRemoving(null);
          }}
        />
      )}
    </>
  );
}
