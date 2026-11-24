import type { PresenceStatus } from './presence-status.model.js';

/** A status other members can see. Invisible and offline members are absent from a snapshot. */
export type VisiblePresenceStatus = Exclude<PresenceStatus, 'invisible'>;

/** One member of the organization with a live lease and a visible status. */
export interface VisiblePresence {
  // #region Properties
  /** Membership in the caller's verified organization and its status as other members see it. */
  readonly memberId: string;
  readonly status: VisiblePresenceStatus;
  // #endregion
}

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
