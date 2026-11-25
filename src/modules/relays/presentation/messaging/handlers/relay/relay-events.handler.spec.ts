import type { EventConsumers } from '@cadenway/nest-messaging';
import { describe, expect, it, vi } from 'vitest';

import type { RelayInvalidationPort } from '../../../../application/ports/outbound/connection/relay/relay-invalidation.port.js';
import { ApplyRelayInvalidation } from '../../../../application/use-cases/commands/relay/apply-relay-invalidation/apply-relay-invalidation.use-case.js';
import type { RelayListTasks } from '../../../../application/use-cases/commands/relay/relay-list-tasks/relay-list-tasks.use-case.js';
import type { RelayTaskChange } from '../../../../application/use-cases/commands/relay/relay-task-change/relay-task-change.use-case.js';
import { RelayEventsHandler } from './relay-events.handler.js';

interface CapturedSubscription {
  // #region Properties
  /** Durable identity and the callback supplied to the messaging kit. */
  readonly handler: string;
  readonly event: string;
  readonly deliverPolicy?: string;
  readonly redelivery?: { readonly maxDeliveries: number; readonly delaysMs: readonly number[] };
  readonly handle: (fact: never, context: { readonly signal: AbortSignal }) => Promise<void>;
  // #endregion
}

function setup(gitRelaysEnabled = true) {
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
    invalidateScope: vi.fn().mockResolvedValue(undefined),
    invalidateTaskRoom: vi.fn().mockResolvedValue(undefined),
  } satisfies RelayInvalidationPort;
  const execute = vi.fn().mockResolvedValue(undefined);
  const changes = { execute } as unknown as RelayTaskChange;
  const listTasksExecute = vi.fn().mockResolvedValue(undefined);
  const listTasks = { execute: listTasksExecute } as unknown as RelayListTasks;
  return {
    listTasks,
    listTasksExecute,
    subscriptions,
    invalidation,
    changes,
    execute,
    handler: new RelayEventsHandler(
      consumers,
      new ApplyRelayInvalidation(invalidation),
      changes,
      listTasks,
      gitRelaysEnabled,
    ),
  };
}

describe('RelayEventsHandler', () => {
  it('keeps Git subscriptions disabled by default', async () => {
    const subscriptions: CapturedSubscription[] = [];
    const consumers = {
      subscribe: vi.fn((subscription: CapturedSubscription) => {
        subscriptions.push(subscription);
        return Promise.resolve();
      }),
    } as unknown as EventConsumers;
    const { invalidation, changes, listTasks } = setup();
    const handler = new RelayEventsHandler(
      consumers,
      new ApplyRelayInvalidation(invalidation),
      changes,
      listTasks,
    );
    await handler.onApplicationBootstrap();
    expect(subscriptions).toHaveLength(19);
    expect(subscriptions.some((subscription) => subscription.event.startsWith('git.'))).toBe(false);
  });

  it('keeps Git subscriptions disabled when explicitly switched off', async () => {
    const { handler, subscriptions } = setup(false);
    await handler.onApplicationBootstrap();
    expect(subscriptions).toHaveLength(19);
    expect(subscriptions.some((subscription) => subscription.event.startsWith('git.'))).toBe(false);
  });

  it('registers the exact durable names once', async () => {
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
        ['relay-task-created', 'task.created.v1'],
        ['relay-task-archived', 'task.archived.v1'],
        ['relay-task-unarchived', 'task.unarchived.v1'],
        ['relay-task-restored', 'task.restored.v1'],
        ['relay-task-status-changed', 'task.status-changed.v1'],
        ['relay-comment-created', 'comment.created.v1'],
        ['relay-git-branch-created', 'git.branch-created.v1'],
        ['relay-git-pr-opened', 'git.pr-opened.v1'],
        ['relay-git-pr-merged', 'git.pr-merged.v1'],
        ['relay-git-pr-closed', 'git.pr-closed.v1'],
        ['relay-git-checks-completed', 'git.checks-completed.v1'],
      ],
    );
  });

  it.each([
    'git.branch-created.v1',
    'git.pr-opened.v1',
    'git.pr-merged.v1',
    'git.pr-closed.v1',
    'git.checks-completed.v1',
  ])('projects %s as a version-one Git invalidation', async (event) => {
    const { handler, subscriptions, execute } = setup();
    await handler.onApplicationBootstrap();
    const subscription = subscriptions.find((candidate) => candidate.event === event);
    expect(subscription).toBeDefined();
    const signal = new AbortController().signal;
    const fact = {
      id: 'EVENT-A',
      occurredAt: '2026-11-20T12:00:00Z',
      organizationId: 'ORG-A',
      version: 8,
      taskKey: 'CAD-42',
      spaceId: 'SPACE-A',
      listId: 'LIST-A',
      actor: { type: 'git', id: 'integration-a' },
      gitLinkId: 'link-a',
      changed: ['state'],
    };
    await subscription?.handle(fact as never, { signal });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      {
        id: 'event-a',
        occurredAt: fact.occurredAt,
        organizationId: 'org-a',
        version: 1,
        key: 'CAD-42',
        spaceId: 'space-a',
        listId: 'list-a',
        type: 'git.links-changed.v1',
        data: {},
      },
      signal,
    );
    await subscription?.handle({ ...fact, actor: { type: 'user', id: 'user-a' } } as never, {
      signal,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('passes the stable list and fact IDs to scoped invalidation', async () => {
    const { handler, subscriptions, invalidation } = setup();
    await handler.onApplicationBootstrap();
    const subscription = subscriptions.find(
      (candidate) => candidate.event === 'list.access-changed.v1',
    );
    expect(subscription).toBeDefined();
    await subscription?.handle(
      { organizationId: 'org-a', listId: 'LIST-A', id: 'event-a' } as never,
      {
        signal: new AbortController().signal,
      },
    );
    expect(invalidation.invalidateScope).toHaveBeenCalledExactlyOnceWith(
      'org-a',
      'list',
      'list-a',
      'event-a',
    );
  });

  it('leaves a failed fence for broker redelivery without disconnecting based on an unknown state', async () => {
    const { handler, subscriptions, invalidation } = setup();
    invalidation.invalidateScope.mockRejectedValue(new Error('Redis unavailable'));
    await handler.onApplicationBootstrap();
    const subscription = subscriptions.find((candidate) => candidate.event === 'space.deleted.v1');
    expect(subscription).toBeDefined();
    await expect(
      subscription?.handle(
        { organizationId: 'org-a', spaceId: 'space-a', id: 'event-a' } as never,
        {
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('Redis unavailable');
    expect(invalidation.invalidateScope).toHaveBeenCalledOnce();
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
    await subscription?.handle(
      { id: 'event-a', organizationId: 'ORG-A', key: 'CAD-42', listId: 'list-a' } as never,
      { signal },
    );
    expect(invalidation.invalidateTaskRoom).toHaveBeenCalledExactlyOnceWith(
      'org-a',
      'CAD-42',
      action,
      signal,
    );
    expect(invalidation.invalidateScope).not.toHaveBeenCalled();
  });

  it('starts new list durables at new facts with the extended retry schedule', async () => {
    const { handler, subscriptions } = setup();
    await handler.onApplicationBootstrap();
    for (const name of [
      'relay-task-created',
      'relay-task-archived',
      'relay-task-unarchived',
      'relay-task-restored',
    ]) {
      expect(subscriptions.find((item) => item.handler === name)).toMatchObject({
        deliverPolicy: 'new',
        redelivery: {
          maxDeliveries: 32,
          delaysMs: [1000, 5000, 30000, 120000, 600000, 1800000, 3600000],
        },
      });
    }
  });

  it.each([
    'task.created.v1',
    'task.archived.v1',
    'task.unarchived.v1',
    'task.restored.v1',
    'task.trashed.v1',
  ])('routes %s to the fact list', async (event) => {
    const { handler, subscriptions, listTasksExecute } = setup();
    await handler.onApplicationBootstrap();
    const signal = new AbortController().signal;
    const fact = { id: 'event-a', organizationId: 'org-a', listId: 'list-a', key: 'CAD-42' };
    await subscriptions
      .find((subscription) => subscription.event === event)
      ?.handle(fact as never, { signal });
    expect(listTasksExecute).toHaveBeenCalledExactlyOnceWith(fact, signal);
  });

  it('sends a move notice only to the former list', async () => {
    const { handler, subscriptions, listTasksExecute, execute } = setup();
    await handler.onApplicationBootstrap();
    const signal = new AbortController().signal;
    const fact = {
      id: 'event-a',
      organizationId: 'org-a',
      listId: 'new',
      previousListId: 'old',
      key: 'CAD-42',
      spaceId: 'space',
      version: 2,
      occurredAt: '2026-01-01T00:00:00Z',
      changed: ['listId'],
    };
    const subscription = subscriptions.find((candidate) => candidate.event === 'task.updated.v1');
    expect(subscription).toBeDefined();
    await subscription?.handle(fact as never, { signal });
    expect(listTasksExecute).toHaveBeenCalledExactlyOnceWith({ ...fact, listId: 'old' }, signal);
    expect(execute).toHaveBeenCalledOnce();
    await subscription?.handle({ ...fact, previousListId: 'new' } as never, { signal });
    expect(listTasksExecute).toHaveBeenCalledOnce();
    const { id, organizationId, listId, key, spaceId, version, occurredAt, changed } = fact;
    const withoutPrevious = {
      id,
      organizationId,
      listId,
      key,
      spaceId,
      version,
      occurredAt,
      changed,
    };
    await subscription?.handle(withoutPrevious as never, { signal });
    expect(listTasksExecute).toHaveBeenCalledOnce();
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
    expect(invalidation.invalidateScope).not.toHaveBeenCalled();
    await subscription?.handle(
      {
        organizationId: 'org-a',
        id: 'event-a',
        spaceId: 'space-a',
        changed: ['ownerUserId'],
      } as never,
      {
        signal,
      },
    );
    expect(invalidation.invalidateScope).toHaveBeenCalledExactlyOnceWith(
      'org-a',
      'space',
      'space-a',
      'event-a',
    );
  });

  it('advances only the moved task subscription fence for a placement change', async () => {
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
    expect(invalidation.invalidateScope).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    await subscription?.handle({ ...fact, changed: ['listId'] } as never, { signal });
    expect(invalidation.invalidateScope).toHaveBeenCalledExactlyOnceWith(
      'org-a',
      'task',
      'CAD-42',
      'event-a',
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
