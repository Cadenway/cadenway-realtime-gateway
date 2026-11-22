import type { RealtimeRoom } from '../../../../models/connection/realtime-room.model.js';
import type { ConnectionRoomProof } from '../../../../models/connection/connection-room-proof.model.js';
import type { RealtimeSession } from '../../../../models/connection/realtime-session.model.js';
import type { RoomSelection } from '../../../../models/connection/room-selection.model.js';
import type { SocketRegistryPort } from '../../../../ports/outbound/redis/connection/socket-registry.port.js';
import type { RoomAccessPort } from '../../../../ports/outbound/task/visibility/room-access.port.js';
import type { ChangeRoomOutput } from './change-room.output.js';

/** Resolves authorized resource rooms and updates only the authenticated socket's registration. */
export class ChangeRoom {
  // #region Constructor
  /** Both Task access and the shared registry are required to enable socket subscriptions. */
  public constructor(
    private readonly access?: RoomAccessPort,
    private readonly registry?: SocketRegistryPort,
  ) {}
  // #endregion

  // #region Methods
  /** Adds or removes an authorized subscription owned by the current socket. */
  public async execute(
    operation: 'join' | 'leave',
    socketId: string,
    session: RealtimeSession,
    selection: RoomSelection,
  ): Promise<ChangeRoomOutput> {
    return operation === 'join'
      ? this.join(socketId, session, selection)
      : this.leave(socketId, session, selection);
  }

  /** Validates visibility before committing a subscription against an unchanged Redis fence. */
  private async join(
    socketId: string,
    session: RealtimeSession,
    selection: RoomSelection,
  ): Promise<ChangeRoomOutput> {
    if (this.registry === undefined || this.access === undefined) return { kind: 'unavailable' };
    if (session.expiresAt <= Date.now()) return { kind: 'invalidated' };
    const fence = await this.registry.readFence(socketId, session);
    if (fence === null) return { kind: 'invalidated' };
    let target: { room: RealtimeRoom; placement?: ConnectionRoomProof } | null;
    try {
      target = await this.resolveRoom(this.access, session, selection);
    } catch {
      // A failed read from Task changed neither the registry nor the transport room.
      return { kind: 'unavailable' };
    }
    if (session.expiresAt <= Date.now()) return { kind: 'invalidated' };
    if (target === null) {
      const current = await this.registry.readFence(socketId, session);
      if (current === null) return { kind: 'invalidated' };
      return { kind: current === fence ? 'not-found' : 'unavailable' };
    }
    const { room, placement } = target;
    const subscription = await this.registry.join(
      socketId,
      session,
      fence,
      selection,
      room,
      placement,
    );
    if (subscription === null) {
      const current = await this.registry.readFence(socketId, session);
      return { kind: current === null ? 'invalidated' : 'unavailable' };
    }
    if (subscription.kind === 'room-limit') return subscription;
    return { kind: 'joined', room, previousRoom: subscription.previousRoom };
  }

  /** Leaves by the stored selector without looking up or disclosing the Task resource. */
  private async leave(
    socketId: string,
    session: RealtimeSession,
    selection: RoomSelection,
  ): Promise<ChangeRoomOutput> {
    if (this.registry === undefined) return { kind: 'unavailable' };
    if (
      session.expiresAt <= Date.now() ||
      (await this.registry.readFence(socketId, session)) === null
    ) {
      return { kind: 'invalidated' };
    }
    return { kind: 'left', room: await this.registry.leave(socketId, session, selection) };
  }

  /** Uses the verified tenant for every lookup and trusts only Task's proven resource identity. */
  private async resolveRoom(
    access: RoomAccessPort,
    session: RealtimeSession,
    selection: RoomSelection,
  ): Promise<{ room: RealtimeRoom; placement?: ConnectionRoomProof } | null> {
    if (selection.kind === 'organization') return { room: `org:${session.organizationId}` };
    if (selection.kind === 'list') {
      const proof = await access.list(session, selection.listId);
      return proof?.organizationId === session.organizationId && proof.listId === selection.listId
        ? { room: `list:${proof.listId}`, placement: proof }
        : null;
    }
    const proof = await access.task(session, selection.taskKey);
    return proof?.organizationId === session.organizationId &&
      proof.taskKey === selection.taskKey &&
      proof.taskId !== undefined
      ? { room: `task:${proof.taskId}`, placement: proof }
      : null;
  }
  // #endregion
}
