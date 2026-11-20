/** An authenticated connection used to scope one presence lease. */
export interface PresenceConnection {
  // #region Properties
  /** Verified organization, membership and server-owned socket. */
  readonly organizationId: string;
  readonly memberId: string;
  readonly socketId: string;

  /** The exact session claims bound to the Redis registration and its expiry in milliseconds. */
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly expiresAt: number;
  readonly userId: string;
  readonly role: 'owner' | 'admin' | 'member' | 'guest';
  // #endregion
}
