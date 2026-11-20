/** One socket and the verified tenant context held by the connection capability. */
export interface RelayRecipient {
  // #region Properties
  /** Socket identity and the organization to which its session is bound. */
  readonly socketId: string;
  readonly session: {
    readonly organizationId: string;
    readonly memberId: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly sessionVersion: number;
    readonly expiresAt: number;
    readonly role: 'owner' | 'admin' | 'member' | 'guest';
  };
  // #endregion
}
