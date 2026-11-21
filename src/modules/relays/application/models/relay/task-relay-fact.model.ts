/** Validated producer data required to select and construct one task notice. */
export interface TaskRelayFact {
  // #region Properties
  /** Original event identity and current placement asserted by the producer. */
  readonly id: string;
  readonly occurredAt: string;
  readonly organizationId: string;
  readonly version: number;
  readonly key: string;
  readonly spaceId: string;
  readonly listId: string;
  readonly type:
    'task.updated.v1' | 'task.status-changed.v1' | 'comment.created.v1' | 'git.links-changed.v1';
  readonly data:
    | { readonly changed: readonly string[] }
    | { readonly commentId: string }
    | Record<string, never>;
  // #endregion
}
