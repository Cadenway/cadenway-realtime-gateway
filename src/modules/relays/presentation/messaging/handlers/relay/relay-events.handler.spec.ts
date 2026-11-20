import type { EventConsumers } from '@cadenway/nest-messaging';
import { describe, expect, it, vi } from 'vitest';

import type { RelayInvalidationPort } from '../../../../application/ports/outbound/connection/relay/relay-invalidation.port.js';
import { ApplyRelayInvalidation } from '../../../../application/use-cases/commands/relay/apply-relay-invalidation/apply-relay-invalidation.use-case.js';
import type { RelayTaskChange } from '../../../../application/use-cases/commands/relay/relay-task-change/relay-task-change.use-case.js';
import { RelayEventsHandler } from './relay-events.handler.js';

interface CapturedSubscription {
  // #region Properties
  /** Durable identity and the callback supplied to the messaging kit. */
  readonly handler: string;
  readonly event: string;
  readonly handle: (fact: never, context: { readonly signal: AbortSignal }) => Promise<void>;
  // #endregion
}

function setup() {
  const subscriptions: CapturedSubscription[] = [];
  const subscribe = vi.fn((subscription: CapturedSubscription) => {
    subscriptions.push(subscription);
    return Promise.resolve();
  });
  const consumers = { subscribe } as unknown as EventConsumers;
  const invalidation = {
    revokeSession: vi.fn().mockResolvedValue(undefined),
    switchSession: vi.fn().mockResolvedValue(undefined),
    removeMember: vi.fn().mockResolvedValue(undefined),
    changeMemberRole: vi.fn().mockResolvedValue(undefined),
    advanceVisibility: vi.fn().mockResolvedValue(undefined),
    disconnectOrganization: vi.fn().mockResolvedValue(undefined),
    invalidateTaskRoom: vi.fn().mockResolvedValue(undefined),
  } satisfies RelayInvalidationPort;
  const execute = vi.fn().mockResolvedValue(undefined);
  const changes = { execute } as unknown as RelayTaskChange;
  return {
    subscriptions,
    invalidation,
    changes,
    execute,
    handler: new RelayEventsHandler(consumers, new ApplyRelayInvalidation(invalidation), changes),
  };
}

describe('RelayEventsHandler', () => {
  it('registers the fifteen exact durable names once', async () => {
    const { handler, subscriptions } = setup();
    await handler.onApplicationBootstrap();
    expect(subscriptions.map((subscription) => [subscription.handler, subscription.event])).toEqual(
      [
        ['relay-session-revoked', 'session.revoked.v1'],
        ['relay-session-organization-changed', 'session.organization-changed.v1'],
        ['relay-member-removed', 'member.removed.v1'],
        ['relay-member-role-changed', 'member.role-changed.v1'],
        ['relay-space-updated', 'space.updated.v1'],
        ['relay-space-access-changed', 'space.access-changed.v1'],
        ['relay-space-access-republished', 'space.access-republished.v1'],
        ['relay-space-deleted', 'space.deleted.v1'],
        ['relay-list-access-changed', 'list.access-changed.v1'],
        ['relay-list-deleted', 'list.deleted.v1'],
        ['relay-task-trashed', 'task.trashed.v1'],
        ['relay-task-purged', 'task.purged.v1'],
        ['relay-task-updated', 'task.updated.v1'],
        ['relay-task-status-changed', 'task.status-changed.v1'],
        ['relay-comment-created', 'comment.created.v1'],
      ],
    );
  });

  it('passes the stable fact ID to atomic organization invalidation', async () => {
    const { handler, subscriptions, invalidation } = setup();
    await handler.onApplicationBootstrap();
    const subscription = subscriptions.find(
      (candidate) => candidate.event === 'list.access-changed.v1',
    );
    expect(subscription).toBeDefined();
    await subscription?.handle({ organizationId: 'org-a', id: 'event-a' } as never, {
      signal: new AbortController().signal,
    });
    expect(invalidation.advanceVisibility).not.toHaveBeenCalled();
    expect(invalidation.disconnectOrganization).toHaveBeenCalledExactlyOnceWith('org-a', 'event-a');
  });

  it('leaves a failed fence for broker redelivery without disconnecting based on an unknown state', async () => {
    const { handler, subscriptions, invalidation } = setup();
    invalidation.disconnectOrganization.mockRejectedValue(new Error('Redis unavailable'));
    await handler.onApplicationBootstrap();
    const subscription = subscriptions.find((candidate) => candidate.event === 'space.deleted.v1');
    expect(subscription).toBeDefined();
    await expect(
      subscription?.handle({ organizationId: 'org-a', id: 'event-a' } as never, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Redis unavailable');
    expect(invalidation.advanceVisibility).not.toHaveBeenCalled();
  });

  it.each([
    ['task.trashed.v1', 'trash'],
    ['task.purged.v1', 'purge'],
  ])('routes %s exclusively to the affected task key', async (event, action) => {
    const { handler, subscriptions, invalidation } = setup();
    await handler.onApplicationBootstrap();
    const subscription = subscriptions.find((candidate) => candidate.event === event);
    const signal = new AbortController().signal;
    expect(subscription).toBeDefined();
    await subscription?.handle({ organizationId: 'ORG-A', key: 'CAD-42' } as never, { signal });
    expect(invalidation.invalidateTaskRoom).toHaveBeenCalledExactlyOnceWith(
      'org-a',
      'CAD-42',
      action,
      signal,
    );
    expect(invalidation.disconnectOrganization).not.toHaveBeenCalled();
  });

  it('projects a producer status fact without its display or audience data', async () => {
    const { handler, subscriptions, execute } = setup();
    await handler.onApplicationBootstrap();
    const subscription = subscriptions.find(
      (candidate) => candidate.event === 'task.status-changed.v1',
    );
    expect(subscription).toBeDefined();
    const signal = new AbortController().signal;
    await subscription?.handle(
      {
        id: 'event-a',
        occurredAt: '2026-11-20T12:00:00Z',
        organizationId: 'org-a',
        version: 2,
        key: 'CAD-42',
        spaceId: 'space-a',
        listId: 'list-a',
        name: 'sensitive name',
        assigneeIds: ['sensitive-user'],
        status: 'done',
      } as never,
      { signal },
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      {
        id: 'event-a',
        occurredAt: '2026-11-20T12:00:00Z',
        organizationId: 'org-a',
        version: 2,
        key: 'CAD-42',
        spaceId: 'space-a',
        listId: 'list-a',
        type: 'task.status-changed.v1',
        data: { changed: ['status'] },
      },
      signal,
    );
  });

  it('keeps sockets connected on a space rename and fences visibility or ownership changes', async () => {
    const { handler, subscriptions, invalidation } = setup();
    await handler.onApplicationBootstrap();
    const subscription = subscriptions.find((candidate) => candidate.event === 'space.updated.v1');
    expect(subscription).toBeDefined();
    const signal = new AbortController().signal;
    await subscription?.handle({ organizationId: 'org-a', changed: ['name'] } as never, { signal });
    expect(invalidation.advanceVisibility).not.toHaveBeenCalled();
    expect(invalidation.disconnectOrganization).not.toHaveBeenCalled();
    await subscription?.handle(
      { organizationId: 'org-a', id: 'event-a', changed: ['ownerUserId'] } as never,
      {
        signal,
      },
    );
    expect(invalidation.advanceVisibility).not.toHaveBeenCalled();
    expect(invalidation.disconnectOrganization).toHaveBeenCalledExactlyOnceWith('org-a', 'event-a');
  });

  it('only advances the task visibility fence for a placement change', async () => {
    const { handler, subscriptions, invalidation, execute } = setup();
    await handler.onApplicationBootstrap();
    const subscription = subscriptions.find((candidate) => candidate.event === 'task.updated.v1');
    expect(subscription).toBeDefined();
    const signal = new AbortController().signal;
    const fact = {
      id: 'event-a',
      organizationId: 'org-a',
      key: 'CAD-42',
      spaceId: 'space-a',
      listId: 'list-a',
      occurredAt: '2026-11-20T12:00:00Z',
      version: 2,
      changed: ['name'],
    };
    await subscription?.handle(fact as never, { signal });
    expect(invalidation.advanceVisibility).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    await subscription?.handle({ ...fact, changed: ['listId'] } as never, { signal });
    expect(invalidation.advanceVisibility).toHaveBeenCalledExactlyOnceWith('org-a');
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
