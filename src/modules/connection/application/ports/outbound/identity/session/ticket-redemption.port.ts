import type { RealtimeSession } from '../../../../models/connection/realtime-session.model.js';

/** Calls Identity once to consume a ticket and validate its session and active membership. */
export interface TicketRedemptionPort {
  // #region Methods
  /** Returns verified contract data or a generic refusal. An ambiguous request must not be retried. */
  redeem(token: string): Promise<RealtimeSession | null>;
  // #endregion
}
