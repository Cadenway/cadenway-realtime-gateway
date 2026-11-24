import { eventSchemas } from '@cadenway/contracts/events/notification-service';
import type { EventConsumers } from '@cadenway/nest-messaging';
import { describe, expect, it, vi } from 'vitest';

import type { RelayPersonalNotice } from '../../../../application/use-cases/commands/relay/relay-personal-notice/relay-personal-notice.use-case.js';
import { NotificationEventsHandler } from './notification-events.handler.js';

interface CapturedSubscription {
  // #region Properties
  /** Subscription identity, schema and callback. */
  readonly handler: string;
  readonly event: string;
  readonly schemas: unknown;
  readonly handle: (fact: never, context: { readonly signal: AbortSignal }) => Promise<void>;
  // #endregion
}

function setup(enabled = true) {
  const subscriptions: CapturedSubscription[] = [];
  const consumers = {
    subscribe: vi.fn((subscription: CapturedSubscription) => {
      subscriptions.push(subscription);
      return Promise.resolve();
    }),
  } as unknown as EventConsumers;
  const execute = vi.fn().mockResolvedValue(undefined);
  const notices = { execute } as unknown as RelayPersonalNotice;
  return {
    subscriptions,
    execute,
    handler: new NotificationEventsHandler(consumers, notices, enabled),
  };
}

const fact = {
  id: 'EVENT-A',
  occurredAt: '2026-11-20T12:00:00Z',
  organizationId: 'ORG-A',
  version: 7,
};

describe('NotificationEventsHandler', () => {
  it('does not subscribe when disabled', async () => {
    const { handler, subscriptions } = setup(false);
    await handler.onApplicationBootstrap();
    expect(subscriptions).toEqual([]);
  });

  it('subscribes to both notification facts with their schemas', async () => {
    const { handler, subscriptions } = setup();
    await handler.onApplicationBootstrap();
    expect(
      subscriptions.map(({ handler: name, event, schemas }) => [name, event, schemas]),
    ).toEqual([
      ['relay-notification-created', 'notification.created.v1', eventSchemas],
      ['relay-reminder-due', 'reminder.due.v1', eventSchemas],
    ]);
  });

  it.each([
    [null, null],
    [
      { kind: 'task-id', taskId: 'TASK-A' },
      { kind: 'task-id', taskId: 'task-a' },
    ],
    [
      { kind: 'task-key', taskKey: 'CAD-42' },
      { kind: 'task-key', taskKey: 'CAD-42' },
    ],
    [
      { kind: 'list', listId: 'LIST-A' },
      { kind: 'list', listId: 'list-a' },
    ],
    [
      { kind: 'space', spaceId: 'SPACE-A' },
      { kind: 'space', spaceId: 'space-a' },
    ],
  ])('maps a notification subject %j to %j', async (subject, expectedSubject) => {
    const { handler, subscriptions, execute } = setup();
    await handler.onApplicationBootstrap();
    const signal = new AbortController().signal;
    const subscription = subscriptions.find(
      (candidate) => candidate.event === 'notification.created.v1',
    );
    expect(subscription).toBeDefined();
    await subscription?.handle({ ...fact, recipientId: 'USER-A', subject } as never, { signal });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      {
        id: 'event-a',
        occurredAt: fact.occurredAt,
        organizationId: 'org-a',
        version: 7,
        accountId: 'user-a',
        subject: expectedSubject,
        type: 'notification.created.v1',
        data: {},
      },
      signal,
    );
  });

  it('maps a reminder to its account and task while preserving the producer version', async () => {
    const { handler, subscriptions, execute } = setup();
    await handler.onApplicationBootstrap();
    const signal = new AbortController().signal;
    const subscription = subscriptions.find((candidate) => candidate.event === 'reminder.due.v1');
    expect(subscription).toBeDefined();
    await subscription?.handle(
      { ...fact, userId: 'USER-A', taskId: 'TASK-A', reminderId: 'REMINDER-A' } as never,
      { signal },
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      {
        id: 'event-a',
        occurredAt: fact.occurredAt,
        organizationId: 'org-a',
        version: 7,
        accountId: 'user-a',
        subject: { kind: 'task-id', taskId: 'task-a' },
        type: 'reminder.due.v1',
        data: { reminderId: 'reminder-a', taskId: 'task-a' },
      },
      signal,
    );
  });
});
