import type { PersonalNoticeSubject } from './personal-notice-subject.model.js';

/** Validated Notification data required to select and construct one personal notice. */
export interface PersonalRelayFact {
  // #region Properties
  /** Original event identity, tenant and aggregate version, preserved in the browser envelope. */
  readonly id: string;
  readonly occurredAt: string;
  readonly organizationId: string;
  readonly version: number;

  /** Account named by the producer in that organization. */
  readonly accountId: string;

  /** Resource that must stay visible to the account, or null when membership alone suffices. */
  readonly subject: PersonalNoticeSubject | null;

  /** Browser notice type and its ID-only data. */
  readonly type: 'notification.created.v1' | 'reminder.due.v1';
  readonly data: Record<string, never> | { readonly reminderId: string; readonly taskId: string };
  // #endregion
}
