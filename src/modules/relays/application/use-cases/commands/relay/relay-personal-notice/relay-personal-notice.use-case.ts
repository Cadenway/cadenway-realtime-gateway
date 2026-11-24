import type { PersonalNotice } from '../../../../models/relay/personal-notice.model.js';
import type { PersonalRelayFact } from '../../../../models/relay/personal-relay-fact.model.js';
import type { RelayRecipient } from '../../../../models/relay/relay-recipient.model.js';
import type { PersonalRelayPort } from '../../../../ports/outbound/connection/relay/personal-relay.port.js';

const concurrency = 8;

/**
 * Sends an inbox or reminder notice to the named account's connections in the fact's
 * organization, through each connection's own member room. Each delivery requires the captured
 * session, membership and visibility fence to stay current, and a subject visible to that account.
 */
export class RelayPersonalNotice {
  // #region Constructor
  /** Binds the account index, Task visibility and the fenced personal transport. */
  public constructor(private readonly connections: PersonalRelayPort) {}
  // #endregion

  // #region Methods
  /** Hidden or missing subjects withhold the notice; an unavailable decision rejects for retry. */
  public async execute(fact: PersonalRelayFact, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const recipients = (
      await this.connections.accountRecipients(fact.organizationId, fact.accountId)
    ).filter(
      ({ session }) =>
        session.organizationId === fact.organizationId && session.userId === fact.accountId,
    );
    signal.throwIfAborted();
    const notice: PersonalNotice = {
      id: fact.id,
      type: fact.type,
      at: fact.occurredAt,
      version: fact.version,
      data: fact.data,
    };
    // One account and role at one visibility epoch shares Task's decision.
    const decisions = new Map<string, Promise<boolean>>();
    for (let offset = 0; offset < recipients.length; offset += concurrency) {
      signal.throwIfAborted();
      const outcomes = await Promise.allSettled(
        recipients
          .slice(offset, offset + concurrency)
          .map((recipient) => this.deliver(recipient, fact, notice, decisions, signal)),
      );
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
  }

  private async deliver(
    recipient: RelayRecipient,
    fact: PersonalRelayFact,
    notice: PersonalNotice,
    decisions: Map<string, Promise<boolean>>,
    signal: AbortSignal,
  ): Promise<void> {
    const fence = await this.connections.fence(recipient);
    signal.throwIfAborted();
    if (fence === null) return;
    if (fact.subject !== null) {
      const key = JSON.stringify([recipient.session.role, fence]);
      let decision = decisions.get(key);
      if (decision === undefined) {
        decision = this.connections.subjectVisible(recipient, fact.subject, signal);
        decisions.set(key, decision);
      }
      if (!(await decision)) return;
      signal.throwIfAborted();
    }
    await this.connections.deliverPersonal(recipient, fence, notice);
  }
  // #endregion
}
