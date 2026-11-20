import type { RelayRecipient } from '../../../../models/relay/relay-recipient.model.js';
import type { TaskNotice } from '../../../../models/relay/task-notice.model.js';
import type { TaskPlacement } from '../../../../models/relay/task-placement.model.js';

/** Authorized socket registry and targeted transport for a task invalidation. */
export interface TaskRelayPort {
  // #region Methods
  /** Lists subscriptions by tenant and the stable producer key or list ID. */
  taskSubscribers(organizationId: string, taskKey: string): Promise<readonly RelayRecipient[]>;

  /** Lists sockets registered for this list in the same organization. */
  listSubscribers(organizationId: string, listId: string): Promise<readonly RelayRecipient[]>;

  /** Captures the still-current socket and organization visibility fence. */
  fence(recipient: RelayRecipient): Promise<string | null>;

  /** Resolves Task's current visibility and placement for this recipient. */
  authorizeTask(
    recipient: RelayRecipient,
    taskKey: string,
    signal: AbortSignal,
  ): Promise<TaskPlacement | null>;

  /** Delivers only if the socket still owns the room and its fence is unchanged. */
  deliver(
    recipient: RelayRecipient,
    room: `task:${string}` | `list:${string}`,
    fence: string,
    notice: TaskNotice,
  ): Promise<boolean>;

  /** Removes a stale task selector or list room only when the captured fence is still current. */
  evict(
    recipient: RelayRecipient,
    selection:
      | { readonly kind: 'task'; readonly taskKey: string }
      | { readonly kind: 'list'; readonly listId: string },
    fence: string,
  ): Promise<void>;
  // #endregion
}
