import type { VisiblePresenceStatus } from './visible-presence-status.model.js';

/** One member of the organization with a live lease and a visible status. */
export interface VisiblePresence {
  // #region Properties
  /** Membership in the caller's verified organization and its status as other members see it. */
  readonly memberId: string;
  readonly status: VisiblePresenceStatus;
  // #endregion
}
