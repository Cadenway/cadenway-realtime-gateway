import type { ConnectionRecipient } from '../../../../models/connection/connection-recipient.model.js';
import type { ConnectionRoomProof } from '../../../../models/connection/connection-room-proof.model.js';
import type { RealtimeRoom } from '../../../../models/connection/realtime-room.model.js';
import type { RealtimeSession } from '../../../../models/connection/realtime-session.model.js';
import type { RoomSelection } from '../../../../models/connection/room-selection.model.js';
import type { RecipientRegistry } from '../../../../ports/outbound/redis/connection/recipient-registry.port.js';
import type { RecipientTransport } from '../../../../ports/outbound/socket-io/connection/recipient-transport.port.js';
import type { RoomAccessPort } from '../../../../ports/outbound/task/visibility/room-access.port.js';

/** Controls recipient discovery, current access, delivery and invalidation for relays. */
export class ConnectionRecipients {
  // #region Constructor
  /** Binds the shared lease registry, cluster transport and authoritative Task access. */
  public constructor(
    private readonly registry: RecipientRegistry,
    private readonly transport: RecipientTransport,
    private readonly access: RoomAccessPort,
  ) {}
  // #endregion

  // #region Methods
  /** Reads a room's recipients, enforcing the producer's trusted organization. */
  public async execute(
    organizationId: string,
    room: RealtimeRoom,
  ): Promise<readonly ConnectionRecipient[]> {
    return this.readWithin(organizationId, room);
  }

  /** Resolves a producer's Task key through the private authorized connection index. */
  public async readTask(
    organizationId: string,
    taskKey: string,
  ): Promise<readonly ConnectionRecipient[]> {
    return this.readWithin(organizationId, `task-key:${organizationId}:${taskKey}`);
  }

  /** Finds candidate recipients subscribed to a list in the organization. */
  public async readList(
    organizationId: string,
    listId: string,
  ): Promise<readonly ConnectionRecipient[]> {
    return this.readWithin(organizationId, `list:${listId}`);
  }

  /** Captures the current lease and visibility generation before consulting the resource owner. */
  public fence(recipient: ConnectionRecipient): Promise<string | null> {
    return this.registry.readFence(recipient.socketId, recipient.session);
  }

  /** Resolves the selected resource as the actor bound at handshake. */
  public async authorized(
    recipient: ConnectionRecipient,
    selection: RoomSelection,
    signal?: AbortSignal,
  ): Promise<ConnectionRoomProof | null> {
    signal?.throwIfAborted();
    if (selection.kind === 'organization') return null;
    const { session } = recipient;
    if (selection.kind === 'list') {
      const proof = await this.access.list(session, selection.listId, signal);
      return proof?.organizationId === session.organizationId && proof.listId === selection.listId
        ? proof
        : null;
    }
    const proof = await this.access.task(session, selection.taskKey, signal);
    return proof?.organizationId === session.organizationId &&
      proof.taskKey === selection.taskKey &&
      proof.taskId !== undefined
      ? proof
      : null;
  }

  /** Hands off a single change only when Redis still validates its exact recipient fence. */
  public deliver(
    recipient: ConnectionRecipient,
    room: RealtimeRoom,
    fence: string,
    packet: unknown,
  ): Promise<boolean> {
    return this.registry.publish(recipient.socketId, recipient.session, fence, room, packet);
  }

  /** Relays a still-current presence transition only to this replica's authorized sockets. */
  public deliverPresence(
    organizationId: string,
    packet: unknown,
    stillCurrent: () => boolean,
  ): Promise<void> {
    return this.transport.deliverPresence(organizationId, packet, stillCurrent);
  }

  /** Removes an obsolete subscription without resolving a hidden task or list. */
  public async evict(
    recipient: ConnectionRecipient,
    selection: RoomSelection,
    fence: string,
  ): Promise<boolean> {
    const room = await this.registry.evict(recipient.socketId, recipient.session, fence, selection);
    if (room === null) return false;
    const rooms =
      selection.kind === 'task'
        ? [room, `task-key:${recipient.session.organizationId}:${selection.taskKey}`]
        : [room];
    this.transport.leave(recipient, rooms);
    return true;
  }

  /** Fences the session permanently, then closes sockets still registered for it. */
  public async revokeSession(sessionId: string, version: number): Promise<void> {
    await this.registry.markSessionRevoked(sessionId, version);
    await this.closeInvalidated(
      `session:${sessionId}`,
      (session) => session.sessionId === sessionId,
    );
  }

  /** Fences earlier context versions, preserving sockets opened in a current context. */
  public async switchSession(sessionId: string, version: number): Promise<void> {
    await this.registry.markOrganizationChanged(sessionId, version);
    await this.closeInvalidated(
      `session:${sessionId}`,
      (session) => session.sessionId === sessionId,
    );
  }

  /** Invalidates and closes the membership only inside the producer's organization. */
  public async removeMember(
    organizationId: string,
    memberId: string,
    version: number,
  ): Promise<void> {
    await this.registry.markMembershipRemoved(organizationId, memberId, version);
    await this.closeMember(organizationId, memberId);
  }

  /** Fences outdated membership assertions and closes only the invalidated connections. */
  public async changeMemberRole(
    organizationId: string,
    memberId: string,
    version: number,
    role: RealtimeSession['role'],
  ): Promise<void> {
    await this.registry.markMembershipRole(organizationId, memberId, version, role);
    await this.closeMember(organizationId, memberId);
  }

  /** Refuses deliveries still carrying the previous visibility epoch. */
  public advanceVisibility(organizationId: string): Promise<void> {
    return this.registry.advanceVisibility(organizationId);
  }

  /** Fences old proofs before removing only affected subscriptions across replicas. */
  public async invalidateTaskRoom(
    organizationId: string,
    taskKey: string,
    action: 'trash' | 'purge',
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.advanceVisibility(organizationId);
    signal.throwIfAborted();
    const recipients = await this.readTask(organizationId, taskKey);
    const selection = { kind: 'task', taskKey } as const;
    const concurrency = 8;
    for (let offset = 0; offset < recipients.length; offset += concurrency) {
      signal.throwIfAborted();
      const outcomes = await Promise.allSettled(
        recipients
          .slice(offset, offset + concurrency)
          .map((recipient) => this.reconcileTaskSelection(recipient, selection, action, signal)),
      );
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    signal.throwIfAborted();
  }

  /** Persists a broad invalidation checked by the watchdog of every existing tenant socket. */
  public disconnectOrganization(organizationId: string, factId: string): Promise<void> {
    return this.registry.invalidateOrganizationLeases(organizationId, factId);
  }

  /** Applies one resource fence before any further delivery can use older authorization. */
  public invalidateScope(
    organizationId: string,
    kind: 'space' | 'list' | 'task',
    scopeId: string,
    factId: string,
  ): Promise<void> {
    return this.registry.invalidateScope(organizationId, kind, scopeId, factId);
  }

  private async reconcileTaskSelection(
    recipient: ConnectionRecipient,
    selection: Extract<RoomSelection, { kind: 'task' }>,
    action: 'trash' | 'purge',
    signal: AbortSignal,
  ): Promise<void> {
    const fence = await this.fence(recipient);
    signal.throwIfAborted();
    if (fence === null) return;
    if (action === 'trash' && (await this.authorized(recipient, selection, signal)) !== null) {
      return;
    }
    signal.throwIfAborted();
    if (await this.evict(recipient, selection, fence)) return;
    const currentFence = await this.fence(recipient);
    if (currentFence !== null && currentFence !== fence) {
      throw new Error('Task room invalidation overlapped with a visibility change.');
    }
  }

  private async readWithin(
    organizationId: string,
    index: string,
  ): Promise<readonly ConnectionRecipient[]> {
    const recipients = await this.transport.read(index);
    return recipients.filter(({ session }) => session.organizationId === organizationId);
  }

  private async closeMember(organizationId: string, memberId: string): Promise<void> {
    await this.closeInvalidated(
      `member:${memberId}`,
      (session) => session.organizationId === organizationId && session.memberId === memberId,
    );
  }

  private async closeInvalidated(
    room: string,
    matches: (session: RealtimeSession) => boolean,
  ): Promise<void> {
    const candidates = await this.transport.read(room, true);
    for (const recipient of candidates) {
      if (!matches(recipient.session) || (await this.fence(recipient)) !== null) continue;
      this.transport.disconnect(recipient);
    }
  }
  // #endregion
}
