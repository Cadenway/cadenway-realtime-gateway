import type { RelayInvalidation } from '../../../../models/relay/relay-invalidation.model.js';
import type { RelayInvalidationPort } from '../../../../ports/outbound/connection/relay/relay-invalidation.port.js';

/** Applies revocation and visibility changes through the Connection capability. */
export class ApplyRelayInvalidation {
  // #region Constructor
  /** Binds the versioned connection invalidation operations. */
  public constructor(private readonly connections: RelayInvalidationPort) {}
  // #endregion

  // #region Methods
  /** Fences first and propagates failures so the broker may redeliver. */
  public async execute(input: RelayInvalidation, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    switch (input.kind) {
      case 'session-revoked':
        await this.connections.revokeSession(input.sessionId, input.version);
        break;
      case 'session-switched':
        await this.connections.switchSession(input.sessionId, input.version);
        break;
      case 'member-removed':
        await this.connections.removeMember(input.organizationId, input.memberId, input.version);
        break;
      case 'member-role':
        await this.connections.changeMemberRole(
          input.organizationId,
          input.memberId,
          input.version,
          input.role,
        );
        break;
      case 'organization':
        await this.connections.disconnectOrganization(input.organizationId, input.factId);
        break;
      case 'visibility':
        await this.connections.advanceVisibility(input.organizationId);
        break;
    }
    signal.throwIfAborted();
  }
  // #endregion
}
