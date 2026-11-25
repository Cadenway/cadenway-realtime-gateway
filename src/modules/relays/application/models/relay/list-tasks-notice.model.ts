/** Minimal browser invalidation of a list's task membership. */
export interface ListTasksNotice {
  // #region Properties
  /** Stable derived identity, protocol version and delivery time. */
  readonly id: string;
  readonly type: 'list.tasks-changed.v1';
  readonly at: string;
  readonly version: number;
  readonly data: { readonly listId: string };
  // #endregion
}
