import type { SocketPresenceStatus } from './socket-presence-status.model.js';

/** One page of the socket organization's presence snapshot, as the browser protocol sends it. */
export interface SocketPresencePage {
  // #region Properties
  /** The socket member's own selected status, including invisible. */
  readonly status: SocketPresenceStatus;

  /** Visible members with a live lease. Offline and invisible members are absent. */
  readonly members: readonly {
    readonly memberId: string;
    readonly status: Exclude<SocketPresenceStatus, 'invisible'>;
  }[];

  /** Opaque cursor of the next page, or null after the last page. */
  readonly nextCursor: string | null;
  // #endregion
}
