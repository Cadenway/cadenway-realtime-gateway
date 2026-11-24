import type { RealtimeSession } from '../../../../models/connection/realtime-session.model.js';
import type { SocketPresencePage } from '../../../../models/connection/socket-presence-page.model.js';
import type { SocketPresenceStatus } from '../../../../models/connection/socket-presence-status.model.js';

/** Binds the owning Presence capability to one already verified socket. */
export interface SocketPresencePort {
  // #region Methods
  /** Starts a lease bounded by the verified session deadline. */
  connect(socketId: string, session: RealtimeSession): Promise<boolean>;

  /** Refreshes a still-live lease. */
  heartbeat(socketId: string, session: RealtimeSession): Promise<boolean>;

  /** Sets a selectable status for the verified membership. */
  set(
    socketId: string,
    session: RealtimeSession,
    status: SocketPresenceStatus,
  ): Promise<boolean | 'limited'>;

  /** Clears only the supplied socket's lease. */
  disconnect(socketId: string, session: RealtimeSession): Promise<void>;

  /** Reads one snapshot page of the verified organization; null when the socket lost authority. */
  list(
    socketId: string,
    session: RealtimeSession,
    cursor: string | null,
  ): Promise<SocketPresencePage | null>;
  // #endregion
}
