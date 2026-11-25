import type { ListTasksNotice } from '../../../../models/relay/list-tasks-notice.model.js';
import type { ListTasksRelayPort } from '../../../../ports/outbound/connection/relay/list-tasks-relay.port.js';

/** Sends list membership invalidations after current list authorization and fencing. */
export class RelayListTasks {
  // #region Constructor
  /** Binds recipient discovery and the fenced list transport. */
  public constructor(private readonly connections: ListTasksRelayPort) {}
  // #endregion

  // #region Methods
  /** Unavailable decisions and repeated fence races reject the broker attempt. */
  public async execute(
    fact: { readonly id: string; readonly organizationId: string; readonly listId: string },
    signal: AbortSignal,
  ): Promise<void> {
    const listId = fact.listId.toLowerCase();
    const organizationId = fact.organizationId.toLowerCase();
    const id = this.connections.listTasksNoticeId(fact.id.toLowerCase());
    for await (const page of this.connections.listSubscribers(organizationId, listId, signal)) {
      for (let offset = 0; offset < page.length; offset += 8) {
        signal.throwIfAborted();
        const outcomes = await Promise.allSettled(
          page.slice(offset, offset + 8).map(async (recipient) => {
            if (recipient.session.organizationId !== organizationId) return;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              const fence = await this.connections.fence(recipient);
              signal.throwIfAborted();
              if (fence === null) return;
              if (!(await this.connections.authorizeList(recipient, listId, signal))) return;
              signal.throwIfAborted();
              const notice: ListTasksNotice = {
                id,
                type: 'list.tasks-changed.v1',
                at: new Date().toISOString(),
                version: 1,
                data: { listId },
              };
              if (await this.connections.deliverListTasks(recipient, listId, fence, notice)) return;
            }
            throw new Error('List notice delivery kept racing with visibility changes.');
          }),
        );
        const failed = outcomes.find((outcome) => outcome.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
    }
    signal.throwIfAborted();
  }
  // #endregion
}
