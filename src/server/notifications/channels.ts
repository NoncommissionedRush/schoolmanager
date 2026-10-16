// Out-of-app notification channels (docs/architecture/phase5-rules.md §2.6).
// IN_APP is implicit: the `Notification` row is the inbox entry. Every
// other registered channel whose `wants` is true gets a `PENDING`
// `NotificationDelivery` row in the same transaction (an outbox); a
// dispatcher would deliver it after commit. v1 registers no channel, so no
// delivery rows are written and nothing calls out.

import type { Audience, NotificationParams, NotificationType } from "./rules";

export type StoredNotificationRow = {
  id: string;
  schoolId: string;
  recipientId: string;
  type: NotificationType;
  audience: Audience;
  params: NotificationParams;
};

export type Recipient = { userId: string };

export type DeliveryResult =
  | { status: "SENT" }
  | { status: "FAILED"; error: string }
  | { status: "SKIPPED" };

export interface NotificationChannel {
  /** `NotificationChannel` enum minus IN_APP. */
  id: "EMAIL";
  /** Whether this recipient gets this type on this channel (preferences later). */
  wants(n: StoredNotificationRow, recipient: Recipient): boolean;
  /** Called after commit with a PENDING delivery; returns SENT / FAILED. */
  deliver(
    n: StoredNotificationRow,
    recipient: Recipient,
  ): Promise<DeliveryResult>;
}

/** The registered channels. Empty in v1: notifications are in-app only. */
const CHANNELS: readonly NotificationChannel[] = [];

export function registeredChannels(): readonly NotificationChannel[] {
  return CHANNELS;
}
