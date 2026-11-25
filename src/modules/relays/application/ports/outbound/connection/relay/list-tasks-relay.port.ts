import type { ListTasksNotice } from '../../../../models/relay/list-tasks-notice.model.js';
import type { RelayRecipient } from '../../../../models/relay/relay-recipient.model.js';

/** Operations required to authorize and publish list membership notices. */
export interface ListTasksRelayPort {
  // #region Methods
  /** Derives the contract UUID from the producer fact ID. */
  listTasksNoticeId(factId: string): string;

  /** Streams candidate list subscribers in the fact's organization. */
  listSubscribers(
    organizationId: string,
    listId: string,
    signal: AbortSignal,
  ): AsyncIterable<readonly RelayRecipient[]>;

  /** Captures the current session and visibility fence. */
  fence(recipient: RelayRecipient): Promise<string | null>;

  /** Checks the same list access used for joining a room. */
  authorizeList(recipient: RelayRecipient, listId: string, signal: AbortSignal): Promise<boolean>;

  /** Publishes only while the captured fence and subscription remain current. */
  deliverListTasks(
    recipient: RelayRecipient,
    listId: string,
    fence: string,
    notice: ListTasksNotice,
  ): Promise<boolean>;
  // #endregion
}
