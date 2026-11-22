import type { RealtimeSession } from '../../../../models/connection/realtime-session.model.js';
import type { TicketRedemptionPort } from '../../../../ports/outbound/identity/session/ticket-redemption.port.js';
import type { MembershipAuthorityPort } from '../../../../ports/outbound/organization/membership/membership-authority.port.js';
import type { SocketRegistryPort } from '../../../../ports/outbound/redis/connection/socket-registry.port.js';

const proofLifetimeMs = 15_000;

interface MembershipProof {
  // #region Properties
  /** Ends the proof lifetime at a fixed interval after the authoritative request starts. */
  readonly validUntil: number;

  /** Shares one pending or completed authority lookup within that lifetime. */
  readonly decision: Promise<boolean>;
  // #endregion
}

/** Redeems a ticket and maintains the socket registration while its authority stays current. */
export class CheckConnection {
  // #region Properties
  /** Current membership proof and pending refresh of each verified socket session. */
  private readonly proofs = new WeakMap<RealtimeSession, MembershipProof>();
  // #endregion

  // #region Constructor
  /** Keeps unconfigured deployments closed until authoritative adapters are bound together. */
  public constructor(
    private readonly tickets?: TicketRedemptionPort,
    private readonly registry?: SocketRegistryPort,
    private readonly membership?: MembershipAuthorityPort,
  ) {}
  // #endregion

  // #region Methods
  /** Consumes a ticket once and rejects an expired or fenced registration. */
  public async execute(socketId: string, token: string): Promise<RealtimeSession | null> {
    if (this.tickets === undefined || this.registry === undefined) return null;
    const session = await this.tickets.redeem(token);
    if (
      session === null ||
      !Number.isSafeInteger(session.expiresAt) ||
      session.expiresAt <= Date.now() ||
      !Number.isSafeInteger(session.sessionVersion) ||
      session.sessionVersion < 1
    ) {
      return null;
    }
    const verified = Object.freeze({ ...session });
    if (!(await this.hasFreshMembership(verified))) return null;
    try {
      return (await this.registry.register(socketId, verified)) ? verified : null;
    } catch (error) {
      // The write may have succeeded before a connection failure. The lease also bounds cleanup.
      await this.release(socketId, verified).catch(() => {
        // Keep the original failure. The registry will expire the registration if cleanup failed.
      });
      throw error;
    }
  }

  /** Rechecks the lease and current markers, optionally at a specific visibility epoch. */
  public async isCurrent(
    socketId: string,
    session: RealtimeSession,
    expectedFence?: string,
  ): Promise<boolean> {
    if (this.registry === undefined || session.expiresAt <= Date.now()) return false;
    const fence = await this.registry.readFence(socketId, session);
    if (fence === null || (expectedFence !== undefined && fence !== expectedFence)) return false;
    return (await this.hasFreshMembership(session)) && session.expiresAt > Date.now();
  }

  /** Releases a registration after disconnect or uncertain room state. */
  public async release(socketId: string, session: RealtimeSession): Promise<void> {
    await this.registry?.unregister(socketId, session);
  }

  /** Reuses one in-flight check per socket and expires the proof from the start of the lookup. */
  private async hasFreshMembership(session: RealtimeSession): Promise<boolean> {
    if (this.membership === undefined) return false;
    const now = Date.now();
    let proof = this.proofs.get(session);
    if (proof === undefined || proof.validUntil <= now) {
      proof = {
        validUntil: now + proofLifetimeMs,
        decision: this.membership.matches(session),
      };
      this.proofs.set(session, proof);
    }
    return (await proof.decision) && proof.validUntil > Date.now();
  }
  // #endregion
}
