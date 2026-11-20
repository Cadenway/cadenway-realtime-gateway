/** Identity's verified session, membership, tenant and lease for one socket. */
export interface RealtimeSession {
  // #region Properties
  /** Session identity, version and effective expiry, in epoch milliseconds. */
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly expiresAt: number;

  /** Account and active membership from Identity, independent of all client room requests. */
  readonly organizationId: string;
  readonly memberId: string;
  readonly userId: string;
  readonly role: 'owner' | 'admin' | 'member' | 'guest';
  // #endregion
}
