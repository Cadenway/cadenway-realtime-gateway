import type { RealtimeRoom } from '../../../../models/connection/realtime-room.model.js';
import type { ConnectionRoomProof } from '../../../../models/connection/connection-room-proof.model.js';
import type { RealtimeSession } from '../../../../models/connection/realtime-session.model.js';
import type { RoomSelection } from '../../../../models/connection/room-selection.model.js';
import type { SocketRegistryJoin } from '../../../../models/connection/socket-registry-join.model.js';

/** Redis is the shared source of socket registrations and invalidation fences. */
export interface SocketRegistryPort {
  // #region Methods
  /**
   * Atomically verifies session and membership markers and writes the leased registration
   * with its organization and personal subscriptions. False means no registration was written.
   */
  register(socketId: string, session: RealtimeSession): Promise<boolean>;

  /** Returns the current organization visibility epoch for this still-valid socket, or null. */
  readFence(socketId: string, session: RealtimeSession): Promise<string | null>;

  /** Atomically compares the epoch and registers the verified subscription and selector. */
  join(
    socketId: string,
    session: RealtimeSession,
    fence: string,
    selection: RoomSelection,
    room: RealtimeRoom,
    placement?: ConnectionRoomProof,
  ): Promise<SocketRegistryJoin>;

  /** Removes this socket's own recorded subscription, without consulting the resource owner. */
  leave(
    socketId: string,
    session: RealtimeSession,
    selection: RoomSelection,
  ): Promise<RealtimeRoom | null>;

  /** Removes only the specified registration and its subscriptions, idempotently. */
  unregister(socketId: string, session: RealtimeSession): Promise<void>;
  // #endregion
}
