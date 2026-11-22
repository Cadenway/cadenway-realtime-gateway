import type { PresenceConnection } from '../../../../models/presence/presence.model.js';
import type { PresenceStatus } from '../../../../models/presence/presence-status.model.js';

/** Atomic, organization-scoped presence leases shared by every gateway instance. */
export interface PresenceStore {
  // #region Methods
  /** Starts a lease for a verified socket and publishes a visible transition. */
  connect(connection: PresenceConnection): Promise<boolean>;

  /** Refreshes an existing socket lease without extending its session. */
  heartbeat(connection: PresenceConnection): Promise<boolean>;

  /** Changes the member preference only while this socket has a live lease. */
  set(connection: PresenceConnection, status: PresenceStatus): Promise<boolean | 'limited'>;

  /** Removes this socket's lease and publishes an offline transition when it was the last. */
  disconnect(connection: PresenceConnection): Promise<void>;

  /** Processes at most the requested number of expired members and returns the count examined. */
  expire(limit: number): Promise<number>;
  // #endregion
}
