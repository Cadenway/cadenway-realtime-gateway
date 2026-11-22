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

  /** Atomically fences authorized subscriptions to one changed resource. */
  invalidateScope(
    organizationId: string,
    resource: 'space' | 'list' | 'task',
    resourceId: string,
    factId: string,
  ): Promise<void>;

  /** Invalidates subscriptions to the affected task while preserving other rooms. */
  invalidateTaskRoom(
    organizationId: string,
    taskKey: string,
    action: 'trash' | 'purge',
    signal: AbortSignal,
  ): Promise<void>;
  // #endregion
}
