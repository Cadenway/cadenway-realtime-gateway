import {
  COMMENT_CREATED_V1,
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
  TASK_PURGED_V1,
  TASK_STATUS_CHANGED_V1,
  TASK_TRASHED_V1,
  TASK_UPDATED_V1,
  eventSchemas,
} from '@cadenway/contracts/events/realtime-gateway';
import type { EventConsumers, EventRedelivery } from '@cadenway/nest-messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';

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
          ? this.invalidateOrganization(fact.organizationId, fact.id, signal)
          : Promise.resolve(),
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.spaceAccessChanged,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: SPACE_ACCESS_CHANGED_V1,
      handle: (fact, { signal }) =>
        this.invalidateOrganization(fact.organizationId, fact.id, signal),
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.spaceAccessRepublished,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: SPACE_ACCESS_REPUBLISHED_V1,
      handle: (fact, { signal }) =>
        this.invalidateOrganization(fact.organizationId, fact.id, signal),
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.spaceDeleted,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: SPACE_DELETED_V1,
      handle: (fact, { signal }) =>
        this.invalidateOrganization(fact.organizationId, fact.id, signal),
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.listAccessChanged,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: LIST_ACCESS_CHANGED_V1,
      handle: (fact, { signal }) =>
        this.invalidateOrganization(fact.organizationId, fact.id, signal),
    });
    await this.consumers.subscribe({
      handler: relayInvalidationHandlers.listDeleted,
      redelivery: invalidationRedelivery,
      schemas: eventSchemas,
      event: LIST_DELETED_V1,
      handle: (fact, { signal }) =>
        this.invalidateOrganization(fact.organizationId, fact.id, signal),
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
          await this.invalidation.execute(
            { kind: 'visibility', organizationId: fact.organizationId.toLowerCase() },
            signal,
          );
        }
        await this.changes.execute(
          taskFact(TASK_UPDATED_V1, fact, { changed: fact.changed }),
          signal,
        );
      },
    });
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
  }

  private async invalidateOrganization(
    organizationId: string,
    factId: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.invalidation.execute(
      {
        kind: 'organization',
        organizationId: organizationId.toLowerCase(),
        factId: factId.toLowerCase(),
      },
      signal,
    );
  }
  // #endregion
}
