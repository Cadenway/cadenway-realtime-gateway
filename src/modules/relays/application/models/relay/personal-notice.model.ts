/** Browser-facing personal notice, containing only the fields in the socket contract. */
export interface PersonalNotice {
  // #region Properties
  /** Original producer identity and aggregate version for client deduplication. */
  readonly id: string;
  readonly type: 'notification.created.v1' | 'reminder.due.v1';
  readonly at: string;
  readonly version: number;

  /** Empty for an inbox invalidation; the reminder and task IDs for a due reminder. */
  readonly data: Record<string, never> | { readonly reminderId: string; readonly taskId: string };
  // #endregion
}
