/** Browser-facing task invalidation, containing only the fields in the socket contract. */
export interface TaskNotice {
  // #region Properties
  /** Original producer identity and aggregate version for client deduplication. */
  readonly id: string;
  readonly type: 'task.updated.v1' | 'task.status-changed.v1' | 'comment.created.v1';
  readonly at: string;
  readonly version: number;
  readonly data:
    | { readonly taskId: string; readonly changed: readonly string[] }
    | { readonly taskId: string; readonly commentId: string };
  // #endregion
}
