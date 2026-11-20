import type { RelayRecipient } from '../../../../models/relay/relay-recipient.model.js';
import type { TaskNotice } from '../../../../models/relay/task-notice.model.js';
import type { TaskPlacement } from '../../../../models/relay/task-placement.model.js';
import type { TaskRelayFact } from '../../../../models/relay/task-relay-fact.model.js';
import type { TaskRelayPort } from '../../../../ports/outbound/connection/relay/task-relay.port.js';

/** Resolves each subscriber against Task before sending a minimal, recipient-specific notice. */
export class RelayTaskChange {
  // #region Constructor
  /** Binds the shared connection registry, current Task access and targeted transport. */
  public constructor(private readonly connections: TaskRelayPort) {}
  // #endregion

  // #region Methods
  /** A stale placement, missing access or invalid fence cannot emit a packet. */
  public async execute(fact: TaskRelayFact, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const taskSubscribers = await this.connections.taskSubscribers(fact.organizationId, fact.key);
    const listSubscribers =
      fact.type === 'comment.created.v1'
        ? []
        : await this.connections.listSubscribers(fact.organizationId, fact.listId);
    const delivered = new Set<string>();
    const proofs = new Map<string, Promise<TaskPlacement | null>>();
    await this.deliverRecipients(taskSubscribers, 'task', fact, signal, delivered, proofs);
    await this.deliverRecipients(listSubscribers, 'list', fact, signal, delivered, proofs);
  }

  private async deliverRecipients(
    recipients: readonly RelayRecipient[],
    source: 'task' | 'list',
    fact: TaskRelayFact,
    signal: AbortSignal,
    delivered: Set<string>,
    proofs: Map<string, Promise<TaskPlacement | null>>,
  ): Promise<void> {
    const concurrency = 8;
    for (let offset = 0; offset < recipients.length; offset += concurrency) {
      signal.throwIfAborted();
      const outcomes = await Promise.allSettled(
        recipients
          .slice(offset, offset + concurrency)
          .map((recipient) =>
            this.deliverRecipient(recipient, source, fact, signal, delivered, proofs),
          ),
      );
      proofs.clear();
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
  }

  private async deliverRecipient(
    recipient: RelayRecipient,
    source: 'task' | 'list',
    fact: TaskRelayFact,
    signal: AbortSignal,
    delivered: Set<string>,
    proofs: Map<string, Promise<TaskPlacement | null>>,
  ): Promise<void> {
    signal.throwIfAborted();
    if (
      recipient.session.organizationId !== fact.organizationId ||
      delivered.has(recipient.socketId)
    )
      return;
    const fence = await this.connections.fence(recipient);
    if (fence === null) return;
    signal.throwIfAborted();
    const accountKey = JSON.stringify([recipient.session.userId, recipient.session.role]);
    let proof = proofs.get(accountKey);
    const shared = proof !== undefined;
    if (proof === undefined) {
      proof = this.connections.authorizeTask(recipient, fact.key, signal);
      proofs.set(accountKey, proof);
    }
    let placement = await proof;
    if (placement === null && shared) {
      signal.throwIfAborted();
      placement = await this.connections.authorizeTask(recipient, fact.key, signal);
    }
    if (placement === null) proofs.delete(accountKey);
    signal.throwIfAborted();
    const selection =
      source === 'task'
        ? { kind: 'task' as const, taskKey: fact.key }
        : { kind: 'list' as const, listId: fact.listId };
    if (placement === null) {
      if (source === 'task') await this.connections.evict(recipient, selection, fence);
      return;
    }
    if (
      placement.organizationId !== fact.organizationId ||
      placement.taskKey !== fact.key ||
      placement.spaceId !== fact.spaceId ||
      placement.listId !== fact.listId
    )
      return;
    const notice: TaskNotice = {
      id: fact.id,
      type: fact.type,
      at: fact.occurredAt,
      version: fact.version,
      data: { taskId: placement.taskId, ...fact.data },
    };
    const room =
      source === 'task' ? (`task:${placement.taskId}` as const) : (`list:${fact.listId}` as const);
    if (await this.connections.deliver(recipient, room, fence, notice))
      delivered.add(recipient.socketId);
  }
  // #endregion
}
