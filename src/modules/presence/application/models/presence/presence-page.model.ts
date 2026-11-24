import type { PresenceStatus } from './presence-status.model.js';
import type { VisiblePresence } from './visible-presence.model.js';

/** One bounded page of the caller organization's visible presence. */
export interface PresencePage {
  // #region Properties
  /** The caller's own selected status, the only place where its invisible preference appears. */
  readonly status: PresenceStatus;

  /** At most one hundred visible members in member ID order, without expired leases. */
  readonly members: readonly VisiblePresence[];

  /** Member ID after which the next page starts, or null after the last page. */
  readonly nextCursor: string | null;
  // #endregion
}
