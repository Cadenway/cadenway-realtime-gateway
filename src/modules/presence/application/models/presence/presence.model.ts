/** An authenticated connection used to scope one presence lease. */
export interface PresenceConnection {
  // #region Properties
  /** Verified organization, membership, socket and session deadline. */
  readonly organizationId: string;
  readonly memberId: string;
  readonly socketId: string;
  readonly sessionExpiresAt: number;
  // #endregion
}
