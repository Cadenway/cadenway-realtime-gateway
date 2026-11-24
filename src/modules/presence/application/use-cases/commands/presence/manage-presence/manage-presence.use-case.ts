import type { PresenceConnection } from '../../../../models/presence/presence.model.js';
import type { PresencePage } from '../../../../models/presence/presence-page.model.js';
import type { PresenceStatus } from '../../../../models/presence/presence-status.model.js';
import type { PresenceStore } from '../../../../ports/outbound/redis/presence/presence-store.port.js';

/** Controls presence for connections whose identity and current authorization were verified. */
export class ManagePresence {
  // #region Constructor
  /** Binds the shared lease store. */
  public constructor(private readonly store: PresenceStore) {}
  // #endregion

  // #region Methods
  /** Starts a socket's presence after the connection registry authorizes it. */
  public execute(connection: PresenceConnection): Promise<boolean> {
    return this.store.connect(connection);
  }

  /** Refreshes only an existing socket's lease. */
  public heartbeat(connection: PresenceConnection): Promise<boolean> {
    return this.store.heartbeat(connection);
  }

  /** Applies a preference to the connection's authenticated membership. */
  public set(connection: PresenceConnection, status: PresenceStatus): Promise<boolean | 'limited'> {
    return this.store.set(connection, status);
  }

  /** Removes one connection without removing another connection's presence. */
  public disconnect(connection: PresenceConnection): Promise<void> {
    return this.store.disconnect(connection);
  }

  /** Reconciles a bounded page of expired memberships. */
  public expire(limit: number): Promise<number> {
    return this.store.expire(limit);
  }

  /** Reads one page of the connection's own organization; null when its authority has ended. */
  public list(connection: PresenceConnection, cursor: string | null): Promise<PresencePage | null> {
    return this.store.list(connection, cursor);
  }
  // #endregion
}
