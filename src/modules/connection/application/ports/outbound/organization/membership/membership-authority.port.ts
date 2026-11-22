import type { RealtimeSession } from '../../../../models/connection/realtime-session.model.js';

/** Confirms the membership under which a leased socket may receive data. */
export interface MembershipAuthorityPort {
  // #region Methods
  /** Compares the verified socket and its optional source binding with Organization. */
  matches(session: RealtimeSession): Promise<boolean>;
  // #endregion
}
