import {
  COMMENT_CREATED_V1,
  GIT_BRANCH_CREATED_V1,
  GIT_CHECKS_COMPLETED_V1,
  GIT_LINK_UPDATED_V1,
  GIT_PR_CLOSED_V1,
  GIT_PR_MERGED_V1,
  GIT_PR_OPENED_V1,
  GIT_PR_REOPENED_V1,
  LIST_ACCESS_CHANGED_V1,
  LIST_DELETED_V1,
  MEMBER_REMOVED_V1,
  MEMBER_ROLE_CHANGED_V1,
  SESSION_ORGANIZATION_CHANGED_V1,
  SESSION_REVOKED_V1,
  SPACE_ACCESS_CHANGED_V1,
  SPACE_ACCESS_REPUBLISHED_V1,
  SPACE_DELETED_V1,
  SPACE_UPDATED_V1,
  TASK_CREATED_V1,
  TASK_ARCHIVED_V1,
  TASK_UNARCHIVED_V1,
  TASK_RESTORED_V1,
  TASK_PURGED_V1,
  TASK_STATUS_CHANGED_V1,
  TASK_TRASHED_V1,
  TASK_UPDATED_V1,
  eventSchemas,
} from '@cadenway/contracts/events/realtime-gateway';
import type { EventConsumers, EventRedelivery } from '@cadenway/nest-messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';

import type { RelayListTasks } from '../../../../application/use-cases/commands/relay/relay-list-tasks/relay-list-tasks.use-case.js';
import type { TaskRelayFact } from '../../../../application/models/relay/task-relay-fact.model.js';
import type { ApplyRelayInvalidation } from '../../../../application/use-cases/commands/relay/apply-relay-invalidation/apply-relay-invalidation.use-case.js';
import type { RelayTaskChange } from '../../../../application/use-cases/commands/relay/relay-task-change/relay-task-change.use-case.js';

/** Durables that can invalidate existing authorization and must catch up before admission. */
export const relayInvalidationHandlers = {
  sessionRevoked: 'relay-session-revoked',
  sessionOrganizationChanged: 'relay-session-organization-changed',
  memberRemoved: 'relay-member-removed',
  memberRoleChanged: 'relay-member-role-changed',
  spaceUpdated: 'relay-space-updated',
  spaceAccessChanged: 'relay-space-access-changed',
  spaceAccessRepublished: 'relay-space-access-republished',
  spaceDeleted: 'relay-space-deleted',
  listAccessChanged: 'relay-list-access-changed',
  listDeleted: 'relay-list-deleted',
  taskTrashed: 'relay-task-trashed',
  taskPurged: 'relay-task-purged',
  taskUpdated: 'relay-task-updated',
} as const;

/**
 * Durables that only send `list.tasks-changed.v1`, apart from the authorization invalidations: they
 * start at new facts and never gate admission.
 */
export const listNoticeHandlers = {
  taskCreated: 'relay-task-created',
  taskArchived: 'relay-task-archived',
  taskUnarchived: 'relay-task-unarchived',
  taskRestored: 'relay-task-restored',
  taskTrashed: 'relay-task-trashed-list',
  taskMoved: 'relay-task-moved-list',
} as const;

// Authorization markers must survive an extended Redis outage while JetStream keeps the fact.
const invalidationRedelivery: EventRedelivery = {
  delaysMs: [1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000],
  maxDeliveries: 32,
};

function taskFact(
  type: TaskRelayFact['type'],
  source: Pick<
    TaskRelayFact,
    'id' | 'occurredAt' | 'organizationId' | 'version' | 'key' | 'spaceId' | 'listId'
  >,
  data: TaskRelayFact['data'],
): TaskRelayFact {
  const { id, occurredAt, organizationId, version, key, spaceId, listId } = source;
  return {
    id: id.toLowerCase(),
    occurredAt,
    organizationId: organizationId.toLowerCase(),
    version,
    key,
    spaceId: spaceId.toLowerCase(),
    listId: listId.toLowerCase(),
    type,
    data,
  };
}

/** Subscribes only to the versioned facts listed by the installed realtime contract. */
export class RelayEventsHandler implements OnApplicationBootstrap {
  // #region Constructor
  /** Binds JetStream deliveries to recipient-scoped notices and monotone fences. */
  public constructor(
    private readonly consumers: EventConsumers,
    private readonly invalidation: ApplyRelayInvalidation,
    private readonly changes: RelayTaskChange,
    private readonly listTasks: RelayListTasks,
    private readonly gitRelaysEnabled = false,
  ) {}
  // #endregion

  // #region Methods
  /** Starts the exact durable consumers; a failed fence leaves the event for redelivery. */
  public async onApplicationBootstrap(): Promise<void> {
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.sessionRevoked,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: SESSION_REVOKED_V1,
      handle: async (fact, { signal }) => {
        signal.throwIfAborted();
        await this.invalidation.execute(
          {
            kind: 'session-revoked',
            sessionId: fact.sessionId.toLowerCase(),
            version: fact.version,
          },
          signal,
        );
        signal.throwIfAborted();
      },
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.sessionOrganizationChanged,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: SESSION_ORGANIZATION_CHANGED_V1,
      handle: async (fact, { signal }) => {
        signal.throwIfAborted();
        await this.invalidation.execute(
          {
            kind: 'session-switched',
            sessionId: fact.sessionId.toLowerCase(),
            version: fact.version,
          },
          signal,
        );
        signal.throwIfAborted();
      },
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.memberRemoved,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: MEMBER_REMOVED_V1,
      handle: async (fact, { signal }) => {
        signal.throwIfAborted();
        await this.invalidation.execute(
          {
            kind: 'member-removed',
            organizationId: fact.organizationId.toLowerCase(),
            memberId: fact.memberId.toLowerCase(),
            version: fact.version,
          },
          signal,
        );
        signal.throwIfAborted();
      },
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.memberRoleChanged,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: MEMBER_ROLE_CHANGED_V1,
      handle: async (fact, { signal }) => {
        signal.throwIfAborted();
        await this.invalidation.execute(
          {
            kind: 'member-role',
            organizationId: fact.organizationId.toLowerCase(),
            memberId: fact.memberId.toLowerCase(),
            version: fact.version,
            role: fact.role,
          },
          signal,
        );
        signal.throwIfAborted();
      },
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.spaceUpdated,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: SPACE_UPDATED_V1,
      handle: (fact, { signal }) =>
        fact.changed.some((field) => field === 'visibility' || field === 'ownerUserId')
          ? this.invalidateScope(fact, 'space', fact.spaceId, signal)
          : Promise.resolve(),
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.spaceAccessChanged,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: SPACE_ACCESS_CHANGED_V1,
      handle: (fact, { signal }) => this.invalidateScope(fact, 'space', fact.spaceId, signal),
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.spaceAccessRepublished,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: SPACE_ACCESS_REPUBLISHED_V1,
      handle: (fact, { signal }) => this.invalidateScope(fact, 'space', fact.spaceId, signal),
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.spaceDeleted,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: SPACE_DELETED_V1,
      handle: (fact, { signal }) => this.invalidateScope(fact, 'space', fact.spaceId, signal),
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.listAccessChanged,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: LIST_ACCESS_CHANGED_V1,
      handle: (fact, { signal }) => this.invalidateScope(fact, 'list', fact.listId, signal),
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.listDeleted,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: LIST_DELETED_V1,
      handle: (fact, { signal }) => this.invalidateScope(fact, 'list', fact.listId, signal),
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.taskTrashed,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: TASK_TRASHED_V1,
      handle: (fact, { signal }) =>
        this.invalidation.execute(
          {
            kind: 'task-room',
            organizationId: fact.organizationId.toLowerCase(),
            taskKey: fact.key,
            action: 'trash',
          },
          signal,
        ),
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.taskPurged,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: TASK_PURGED_V1,
      handle: (fact, { signal }) =>
        this.invalidation.execute(
          {
            kind: 'task-room',
            organizationId: fact.organizationId.toLowerCase(),
            taskKey: fact.key,
            action: 'purge',
          },
          signal,
        ),
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.taskUpdated,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: TASK_UPDATED_V1,
      handle: async (fact, { signal }) => {
        signal.throwIfAborted();
        if (fact.changed.some((field) => ['listId', 'spaceId', 'parentKey'].includes(field))) {
          await this.invalidateScope(fact, 'task', fact.key, signal);
        }
        await this.changes.execute(
          taskFact(TASK_UPDATED_V1, fact, { changed: fact.changed }),
          signal,
        );
      },
    });
    // List notices never share a durable with an authorization invalidation: a notice that keeps
    // failing must not latch the advisory that closes admission.
    await this.consumers.subscribe({
      handler: listNoticeHandlers.taskMoved,
      deliverPolicy: 'new',
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: TASK_UPDATED_V1,
      handle: async (fact, { signal, deliveryCount }) => {
        if (
          fact.previousListId === undefined ||
          fact.previousListId.toLowerCase() === fact.listId.toLowerCase()
        ) {
          return;
        }
        await this.listTasks.execute(
          { ...fact, listId: fact.previousListId },
          signal,
          deliveryCount,
        );
      },
    });
    for (const [handler, event] of [
      [listNoticeHandlers.taskCreated, TASK_CREATED_V1],
      [listNoticeHandlers.taskArchived, TASK_ARCHIVED_V1],
      [listNoticeHandlers.taskUnarchived, TASK_UNARCHIVED_V1],
      [listNoticeHandlers.taskRestored, TASK_RESTORED_V1],
      [listNoticeHandlers.taskTrashed, TASK_TRASHED_V1],
    ] as const) {
      await this.consumers.subscribe({
        handler,
        deliverPolicy: 'new',
        redelivery: invalidationRedelivery,
        schemas: eventSchemas,
        event,
        handle: async (fact, { signal, deliveryCount }) => {
          await this.listTasks.execute(fact, signal, deliveryCount);
        },
      });
    }
    await this.consumers.subscribe({
      handler: 'relay-task-status-changed',
      schemas: eventSchemas,
      event: TASK_STATUS_CHANGED_V1,
      handle: (fact, { signal }) =>
        this.changes.execute(
          taskFact(TASK_STATUS_CHANGED_V1, fact, { changed: ['status'] }),
          signal,
        ),
    });
    await this.consumers.subscribe({
      handler: 'relay-comment-created',
      schemas: eventSchemas,
      event: COMMENT_CREATED_V1,
      handle: (fact, { signal }) =>
        this.changes.execute(
          taskFact(COMMENT_CREATED_V1, fact, { commentId: fact.commentId.toLowerCase() }),
          signal,
        ),
    });
    if (!this.gitRelaysEnabled) return;
    for (const [handler, event] of [
      ['relay-git-branch-created', GIT_BRANCH_CREATED_V1],
      ['relay-git-pr-opened', GIT_PR_OPENED_V1],
      ['relay-git-pr-merged', GIT_PR_MERGED_V1],
      ['relay-git-pr-closed', GIT_PR_CLOSED_V1],
      ['relay-git-checks-completed', GIT_CHECKS_COMPLETED_V1],
      ['relay-git-pr-reopened', GIT_PR_REOPENED_V1],
      ['relay-git-link-updated', GIT_LINK_UPDATED_V1],
    ] as const) {
      // A Git durable created on first deployment starts at new facts: replaying retained history
      // would only send obsolete invalidations. An existing durable keeps its position.
      await this.consumers.subscribe({
        handler,
        deliverPolicy: 'new',
        schemas: eventSchemas,
        event,
        handle: (fact, { signal }) => {
          signal.throwIfAborted();
          if (fact.actor.type !== 'git') return Promise.resolve();
          return this.changes.execute(
            taskFact(
              'git.links-changed.v1',
              {
                id: fact.id,
                occurredAt: fact.occurredAt,
                organizationId: fact.organizationId,
                version: 1,
                key: fact.taskKey,
                spaceId: fact.spaceId,
                listId: fact.listId,
              },
              {},
            ),
            signal,
          );
        },
      });
    }
  }

  private async invalidateScope(
    fact: { readonly organizationId: string; readonly id: string },
    resource: 'space' | 'list' | 'task',
    resourceId: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.invalidation.execute(
      {
        kind: 'visibility',
        organizationId: fact.organizationId.toLowerCase(),
        resource,
        resourceId: resource === 'task' ? resourceId : resourceId.toLowerCase(),
        factId: fact.id.toLowerCase(),
      },
      signal,
    );
  }
  // #endregion
}
