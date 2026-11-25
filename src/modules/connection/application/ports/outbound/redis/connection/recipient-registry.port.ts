import type { RealtimeRoom } from '../../../../models/connection/realtime-room.model.js';
import type { RealtimeSession } from '../../../../models/connection/realtime-session.model.js';
import type { RoomSelection } from '../../../../models/connection/room-selection.model.js';
import type { SocketRegistryPort } from './socket-registry.port.js';

/** Shared lease, subscription and invalidation checks for authorized fan-out. */
export interface RecipientRegistry extends Pick<SocketRegistryPort, 'readFence'> {
  // #region Methods
  /** Checks whether this socket already received a notice in the retained window. */
  noticeDelivered(organizationId: string, noticeId: string, socketId: string): Promise<boolean>;

  /** Atomically checks the current lease and publishes one notice to the owning replica. */
  publish(
    socketId: string,
    session: RealtimeSession,
    fence: string,
    room: RealtimeRoom,
    packet: unknown,
    noticeId?: string,
  ): Promise<boolean>;

  /** Removes an exact selector at the checked epoch. */
  evict(
    socketId: string,
    session: RealtimeSession,
    fence: string,
    selection: RoomSelection,
  ): Promise<RealtimeRoom | null>;

  /** Records a monotone organization-context change. */
  markOrganizationChanged(sessionId: string, version: number): Promise<void>;

  /** Records a terminal session invalidation. */
  markSessionRevoked(sessionId: string, version: number): Promise<void>;

  /** Records the newest role for a single tenant membership. */
  markMembershipRole(
    organizationId: string,
    memberId: string,
    version: number,
    role: RealtimeSession['role'],
  ): Promise<void>;

  /** Records a terminal membership invalidation within one tenant. */
  markMembershipRemoved(organizationId: string, memberId: string, version: number): Promise<void>;

  /** Advances a tenant's epoch before processing scope changes. */
  advanceVisibility(organizationId: string): Promise<void>;

  /** Invalidates existing organization leases, including an unreachable transport. */
  invalidateOrganizationLeases(organizationId: string, factId: string): Promise<void>;

  /** Records that only subscriptions using this owner-verified resource need a new lease. */
  invalidateScope(
    organizationId: string,
    kind: 'space' | 'list' | 'task',
    scopeId: string,
    factId: string,
  ): Promise<void>;
  // #endregion
}
