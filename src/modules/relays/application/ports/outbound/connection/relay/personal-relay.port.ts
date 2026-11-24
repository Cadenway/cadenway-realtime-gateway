import type { PersonalNotice } from '../../../../models/relay/personal-notice.model.js';
import type { PersonalNoticeSubject } from '../../../../models/relay/personal-notice-subject.model.js';
import type { RelayRecipient } from '../../../../models/relay/relay-recipient.model.js';

/** Account-scoped recipient lookup, current visibility and personal-room delivery. */
export interface PersonalRelayPort {
  // #region Methods
  /** Reads the ready connections authenticated as the account in the producer's organization. */
  accountRecipients(organizationId: string, userId: string): Promise<readonly RelayRecipient[]>;

  /** Captures the still-current socket and organization visibility fence. */
  fence(recipient: RelayRecipient): Promise<string | null>;

  /** Asks Task, as the recipient's account, whether the subject is currently visible. */
  subjectVisible(
    recipient: RelayRecipient,
    subject: PersonalNoticeSubject,
    signal: AbortSignal,
  ): Promise<boolean>;

  /** Delivers to the recipient's own member room only if its fence is unchanged. */
  deliverPersonal(
    recipient: RelayRecipient,
    fence: string,
    notice: PersonalNotice,
  ): Promise<boolean>;
  // #endregion
}
