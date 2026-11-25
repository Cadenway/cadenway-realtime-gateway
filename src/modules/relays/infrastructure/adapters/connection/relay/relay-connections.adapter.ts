import { createHash } from 'node:crypto';

import type { ListTasksNotice } from '../../../../application/models/relay/list-tasks-notice.model.js';
import type { ConnectionRecipients } from '../../../../../connection/public/connection/connection-recipients.js';
import type { PersonalNotice } from '../../../../application/models/relay/personal-notice.model.js';
import type { PersonalNoticeSubject } from '../../../../application/models/relay/personal-notice-subject.model.js';
import type { RelayRecipient } from '../../../../application/models/relay/relay-recipient.model.js';
import type { TaskNotice } from '../../../../application/models/relay/task-notice.model.js';
import type { TaskPlacement } from '../../../../application/models/relay/task-placement.model.js';
import type { RelayInvalidationPort } from '../../../../application/ports/outbound/connection/relay/relay-invalidation.port.js';
import type { PersonalRelayPort } from '../../../../application/ports/outbound/connection/relay/personal-relay.port.js';
import type { ListTasksRelayPort } from '../../../../application/ports/outbound/connection/relay/list-tasks-relay.port.js';
import type { TaskRelayPort } from '../../../../application/ports/outbound/connection/relay/task-relay.port.js';

function noticeId(factId: string): string {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const hash = createHash('sha1')
    .update(namespace)
    .update(`urn:cadenway:list.tasks-changed.v1:${factId}`)
    .digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Adapts relay operations to the connection capability's authorized public entry point. */
export class RelayConnectionsAdapter
  implements TaskRelayPort, RelayInvalidationPort, PersonalRelayPort, ListTasksRelayPort
{
  // #region Constructor
  /** Binds the cluster-wide connection registry and targeted Socket.IO transport. */
  public constructor(private readonly connections: ConnectionRecipients) {}
  // #endregion

  // #region Methods
  /** Reads only subscribers in the fact's organization. */
  public taskSubscribers(
    organizationId: string,
    taskKey: string,
    signal: AbortSignal,
  ): AsyncIterable<readonly RelayRecipient[]> {
    return this.connections.scanTask(organizationId, taskKey, signal);
  }

  /** Reads only the requested tenant's list subscribers. */
  public listSubscribers(
    organizationId: string,
    listId: string,
    signal: AbortSignal,
  ): AsyncIterable<readonly RelayRecipient[]> {
    return this.connections.scanList(organizationId, listId, signal);
  }

  /** Checks shared progress before reauthorizing a socket. */
  public noticeDelivered(recipient: RelayRecipient, noticeId: string): Promise<boolean> {
    return this.connections.noticeDelivered(recipient, noticeId);
  }

  /** Captures the socket's current shared fence. */
  public fence(recipient: RelayRecipient): Promise<string | null> {
    return this.connections.fence(recipient);
  }

  /** Derives the stable URL namespace UUID required by the browser contract. */
  public listTasksNoticeId(factId: string): string {
    return noticeId(factId);
  }

  /** Checks current list access through the same path as a room join. */
  public async authorizeList(
    recipient: RelayRecipient,
    listId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    return (
      (await this.connections.authorized(recipient, { kind: 'list', listId }, signal)) !== null
    );
  }

  /** Publishes the list notice only while the captured fence remains current. */
  public deliverListTasks(
    recipient: RelayRecipient,
    listId: string,
    fence: string,
    notice: ListTasksNotice,
  ): Promise<boolean> {
    return this.connections.deliver(recipient, `list:${listId}`, fence, notice, notice.id);
  }

  /** Demands Task's complete current proof; an older or hidden result is withheld. */
  public async authorizeTask(
    recipient: RelayRecipient,
    taskKey: string,
    signal: AbortSignal,
  ): Promise<TaskPlacement | null> {
    const proof = await this.connections.authorized(recipient, { kind: 'task', taskKey }, signal);
    if (proof?.taskId === undefined || proof.taskKey === undefined) return null;
    return {
      organizationId: recipient.session.organizationId,
      taskId: proof.taskId,
      taskKey: proof.taskKey,
      spaceId: proof.spaceId,
      listId: proof.listId,
    };
  }

  /** Emits to the individual socket after its connection capability verifies the fence. */
  public deliver(
    recipient: RelayRecipient,
    room: `task:${string}` | `list:${string}`,
    fence: string,
    notice: TaskNotice,
  ): Promise<boolean> {
    return this.connections.deliver(recipient, room, fence, notice);
  }

  /** Removes a stale selector through the connection owner. */
  public async evict(
    recipient: RelayRecipient,
    selection:
      | { readonly kind: 'task'; readonly taskKey: string }
      | { readonly kind: 'list'; readonly listId: string },
    fence: string,
  ): Promise<void> {
    await this.connections.evict(recipient, selection, fence);
  }

  /** Reads only the named account's ready connections in the producer's organization. */
  public accountRecipients(
    organizationId: string,
    userId: string,
  ): Promise<readonly RelayRecipient[]> {
    return this.connections.readAccount(organizationId, userId);
  }

  /** Asks Task for the subject's current visibility as the recipient's account. */
  public subjectVisible(
    recipient: RelayRecipient,
    subject: PersonalNoticeSubject,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.connections.subjectVisible(recipient, subject, signal);
  }

  /** Emits only through the recipient's own member room after the fence check in Redis. */
  public deliverPersonal(
    recipient: RelayRecipient,
    fence: string,
    notice: PersonalNotice,
  ): Promise<boolean> {
    return this.connections.deliver(
      recipient,
      `member:${recipient.session.memberId}`,
      fence,
      notice,
    );
  }

  /** Records a terminal session fence and closes its sockets. */
  public revokeSession(sessionId: string, version: number): Promise<void> {
    return this.connections.revokeSession(sessionId, version);
  }

  /** Invalidates older contexts after an organization switch. */
  public switchSession(sessionId: string, version: number): Promise<void> {
    return this.connections.switchSession(sessionId, version);
  }

  /** Invalidates a membership only in its own organization. */
  public removeMember(organizationId: string, memberId: string, version: number): Promise<void> {
    return this.connections.removeMember(organizationId, memberId, version);
  }

  /** Invalidates earlier role assertions before reconnecting. */
  public changeMemberRole(
    organizationId: string,
    memberId: string,
    version: number,
    role: 'owner' | 'admin' | 'member' | 'guest',
  ): Promise<void> {
    return this.connections.changeMemberRole(organizationId, memberId, version, role);
  }

  /** Applies only the fence of the affected list, space or task. */
  public invalidateScope(
    organizationId: string,
    resource: 'space' | 'list' | 'task',
    resourceId: string,
    factId: string,
  ): Promise<void> {
    return this.connections.invalidateScope(organizationId, resource, resourceId, factId);
  }

  /** Reconciles only the affected task room through the Connection capability. */
  public invalidateTaskRoom(
    organizationId: string,
    taskKey: string,
    action: 'trash' | 'purge',
    signal: AbortSignal,
  ): Promise<void> {
    return this.connections.invalidateTaskRoom(organizationId, taskKey, action, signal);
  }
  // #endregion
}
