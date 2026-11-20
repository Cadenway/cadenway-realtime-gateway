import type { RealtimeSession } from './realtime-session.model.js';

/** A socket and its verified session returned by the cluster delivery index. */
export interface ConnectionRecipient {
  // #region Properties
  /** Transport identity for targeted delivery. */
  readonly socketId: string;

  /** Verified, leased session captured at admission. */
  readonly session: RealtimeSession;
  // #endregion
}
