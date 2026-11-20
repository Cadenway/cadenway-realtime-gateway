/** Applies versioned revocations and visibility fences before socket deliveries continue. */
export interface RelayInvalidationPort {
  // #region Methods
  /** Makes a revoked session terminal and closes every associated socket. */
  revokeSession(sessionId: string, version: number): Promise<void>;

  /** Closes only sockets bound to an older version of the switched session. */
  switchSession(sessionId: string, version: number): Promise<void>;

  /** Marks a removed membership and closes its sockets in this organization. */
  removeMember(organizationId: string, memberId: string, version: number): Promise<void>;

  /** Records the new role and closes the membership's sockets before they reconnect. */
  changeMemberRole(
    organizationId: string,
    memberId: string,
    version: number,
    role: 'owner' | 'admin' | 'member' | 'guest',
  ): Promise<void>;

  /** Advances the shared visibility epoch without admitting stale proofs. */
  advanceVisibility(organizationId: string): Promise<void>;

  /** Atomically fences tenant sockets once for the given producer fact. */
  disconnectOrganization(organizationId: string, factId: string): Promise<void>;

  /** Invalidates subscriptions to the affected task while preserving other rooms. */
  invalidateTaskRoom(
    organizationId: string,
    taskKey: string,
    action: 'trash' | 'purge',
    signal: AbortSignal,
  ): Promise<void>;
  // #endregion
}
