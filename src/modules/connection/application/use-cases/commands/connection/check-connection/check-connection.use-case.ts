import type { RealtimeSession } from '../../../../models/connection/realtime-session.model.js';
import type { TicketRedemptionPort } from '../../../../ports/outbound/identity/session/ticket-redemption.port.js';
import type { SocketRegistryPort } from '../../../../ports/outbound/redis/connection/socket-registry.port.js';

/** Redeems a ticket and maintains the socket registration until its Identity lease ends. */
export class CheckConnection {
  // #region Constructor
  /** Keeps unconfigured deployments closed until authoritative adapters are bound together. */
  public constructor(
    private readonly tickets?: TicketRedemptionPort,
    private readonly registry?: SocketRegistryPort,
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
    return (
      fence !== null &&
      session.expiresAt > Date.now() &&
      (expectedFence === undefined || fence === expectedFence)
    );
  }

  /** Releases a registration after disconnect or uncertain room state. */
  public async release(socketId: string, session: RealtimeSession): Promise<void> {
    await this.registry?.unregister(socketId, session);
  }
  // #endregion
}
