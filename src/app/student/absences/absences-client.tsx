"use client";

import { CalendarClock, CalendarX } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { CancelBookingDialog } from "@/components/absences/cancel-booking-dialog";
import { CancelLessonDialog } from "@/components/absences/cancel-lesson-dialog";
import { RescheduleSheet } from "@/components/absences/reschedule-sheet";
import { Button } from "@/components/ui/button";
import type { StudentUpcomingBooking } from "@/server/replacements/views";

/** "Reschedule" on a 1-on-1 credit card (absences.md §5.4). */
export function RescheduleCreditButton({ creditId }: { creditId: string }) {
  const t = useTranslations("credits");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="lg" className="w-full" onClick={() => setOpen(true)}>
        <CalendarClock aria-hidden="true" />
        {t("reschedule")}
      </Button>
      <RescheduleSheet
        source={{ creditId }}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/**
 * The action on an upcoming booking (§5.4, §5.7): "Cancel booking" for a
 * replacement; for a rescheduled 1-on-1 the Reschedule sheet before its
 * cutoff (move again or cancel), the late cancel dialog after it.
 */
export function BookingActions({
  booking,
  cutoffMinutes,
  nowIso,
}: {
  booking: StudentUpcomingBooking;
  cutoffMinutes: number;
  nowIso: string;
}) {
  const tb = useTranslations("bookings");
  const ta = useTranslations("absences");
  const tc = useTranslations("credits");
  const [cancelling, setCancelling] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const before =
    new Date(nowIso).getTime() <= new Date(booking.cutoffAt).getTime();

  if (booking.kind === "replacement" && booking.bookingId) {
    return (
      <>
        <Button
          variant="outline"
          size="lg"
          className="self-start"
          onClick={() => setCancelling(true)}
        >
          <CalendarX aria-hidden="true" />
          {tb("cancelBooking")}
        </Button>
        <CancelBookingDialog
          open={cancelling}
          onOpenChange={setCancelling}
          booking={{
            bookingId: booking.bookingId,
            groupName: booking.groupName,
            date: booking.date,
            startMinute: booking.startMinute,
            endMinute: booking.endMinute,
            startsAt: booking.startsAt,
            cutoffAt: booking.cutoffAt,
            credit: booking.credit,
          }}
        />
      </>
    );
  }
  return (
    <>
      <Button
        variant="outline"
        size="lg"
        className="self-start"
        onClick={() => (before ? setRescheduling(true) : setCancelling(true))}
      >
        {before ? (
          <CalendarClock aria-hidden="true" />
        ) : (
          <CalendarX aria-hidden="true" />
        )}
        {before ? tc("reschedule") : ta("cantAttend")}
      </Button>
      <RescheduleSheet
        source={{ lessonId: booking.lessonId }}
        open={rescheduling}
        onOpenChange={setRescheduling}
        onCancelLater={() => setCancelling(true)}
      />
      <CancelLessonDialog
        open={cancelling}
        onOpenChange={setCancelling}
        lesson={{
          id: booking.lessonId,
          groupName: booking.groupName,
          level: "",
          oneOnOne: true,
          teacherName: booking.teacherName,
          date: booking.date,
          startMinute: booking.startMinute,
          endMinute: booking.endMinute,
          attendance: {
            cutoffAt: booking.cutoffAt,
            cutoffMinutes,
            creditValidUntil: booking.creditValidUntil,
            cancelled: null,
            booking: {
              kind: "rescheduled",
              bookingId: null,
              originalDate: booking.originalDate,
              credit: booking.credit,
            },
          },
        }}
      />
    </>
  );
}
