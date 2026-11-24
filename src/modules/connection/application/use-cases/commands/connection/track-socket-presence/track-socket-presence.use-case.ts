import type { RealtimeSession } from '../../../../models/connection/realtime-session.model.js';
import type { SocketPresencePage } from '../../../../models/connection/socket-presence-page.model.js';
import type { SocketPresenceStatus } from '../../../../models/connection/socket-presence-status.model.js';
import type { SocketPresencePort } from '../../../../ports/outbound/presence/connection/socket-presence.port.js';

/** Manages a verified socket's presence lease through the owning capability. */
export class TrackSocketPresence {
  // #region Constructor
  /** Receives the provider of the shared lease operations. */
  public constructor(private readonly presence: SocketPresencePort) {}
  // #endregion

  // #region Methods
  /** Opens the presence lease for the socket just authorized by Connection. */
  public execute(socketId: string, session: RealtimeSession): Promise<boolean> {
    return this.presence.connect(socketId, session);
  }

  /** Refreshes the presence lease for a current socket. */
  public heartbeat(socketId: string, session: RealtimeSession): Promise<boolean> {
    return this.presence.heartbeat(socketId, session);
  }

  /** Changes the status of the membership established at admission. */
  public set(
    socketId: string,
    session: RealtimeSession,
    status: SocketPresenceStatus,
  ): Promise<boolean | 'limited'> {
    return this.presence.set(socketId, session, status);
  }

  /** Releases one socket after its transport closes. */
  public disconnect(socketId: string, session: RealtimeSession): Promise<void> {
    return this.presence.disconnect(socketId, session);
  }

  /** Reads one snapshot page of the organization established at admission. */
  public list(
    socketId: string,
    session: RealtimeSession,
    cursor: string | null,
  ): Promise<SocketPresencePage | null> {
    return this.presence.list(socketId, session, cursor);
  }
  // #endregion
}
