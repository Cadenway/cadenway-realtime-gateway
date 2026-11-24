import {
  NOTIFICATION_CREATED_V1,
  REMINDER_DUE_V1,
  eventSchemas,
} from '@cadenway/contracts/events/notification-service';
import type { NotificationCreatedV1 } from '@cadenway/contracts/events/notification-service';
import type { EventConsumers } from '@cadenway/nest-messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';

import type { PersonalNoticeSubject } from '../../../../application/models/relay/personal-notice-subject.model.js';
import type { RelayPersonalNotice } from '../../../../application/use-cases/commands/relay/relay-personal-notice/relay-personal-notice.use-case.js';

/** Durable consumer names of the personal notice relays, granted separately by the broker. */
export const personalNoticeHandlers = {
  notificationCreated: 'relay-notification-created',
  reminderDue: 'relay-reminder-due',
} as const;

/** Canonicalizes Notification's subject reference without changing its meaning. */
function subjectOf(subject: NotificationCreatedV1['subject']): PersonalNoticeSubject | null {
  switch (subject?.kind) {
    case undefined:
      return null;
    case 'task-id':
      return { kind: 'task-id', taskId: subject.taskId.toLowerCase() };
    case 'task-key':
      return { kind: 'task-key', taskKey: subject.taskKey };
    case 'list':
      return { kind: 'list', listId: subject.listId.toLowerCase() };
    case 'space':
      return { kind: 'space', spaceId: subject.spaceId.toLowerCase() };
  }
}

/**
 * Subscribes to the Notification facts the realtime contract consumes for personal notices. The
 * payloads are the installed notification-service validators, identical to the realtime ones.
 */
export class NotificationEventsHandler implements OnApplicationBootstrap {
  // #region Constructor
  /** Binds JetStream deliveries to account-scoped notices; disabled until the broker grants them. */
  public constructor(
    private readonly consumers: EventConsumers,
    private readonly notices: RelayPersonalNotice,
    private readonly enabled = false,
  ) {}
  // #endregion

  // #region Methods
  /** Starts both durables when enabled; a failed visibility decision leaves the fact for retry. */
  public async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    await this.consumers.subscribe({
      handler: personalNoticeHandlers.notificationCreated,
      schemas: eventSchemas,
      event: NOTIFICATION_CREATED_V1,
      handle: (fact, { signal }) =>
        this.notices.execute(
          {
            id: fact.id.toLowerCase(),
            occurredAt: fact.occurredAt,
            organizationId: fact.organizationId.toLowerCase(),
            version: fact.version,
            accountId: fact.recipientId.toLowerCase(),
            subject: subjectOf(fact.subject),
            type: NOTIFICATION_CREATED_V1,
            data: {},
          },
          signal,
        ),
    });
    await this.consumers.subscribe({
      handler: personalNoticeHandlers.reminderDue,
      schemas: eventSchemas,
      event: REMINDER_DUE_V1,
      handle: (fact, { signal }) => {
        const taskId = fact.taskId.toLowerCase();
        return this.notices.execute(
          {
            id: fact.id.toLowerCase(),
            occurredAt: fact.occurredAt,
            organizationId: fact.organizationId.toLowerCase(),
            version: fact.version,
            accountId: fact.userId.toLowerCase(),
            subject: { kind: 'task-id', taskId },
            type: REMINDER_DUE_V1,
            data: { reminderId: fact.reminderId.toLowerCase(), taskId },
          },
          signal,
        );
      },
    });
  }
  // #endregion
}
